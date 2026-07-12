import { describe, expect, test } from "bun:test";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { EnqueueRunInboxInput } from "../../db/repos/run-inbox.ts";
import type { RunInboxRow } from "../../db/schema.ts";
import type { RunHandle } from "../contract.ts";
import { RuntimeProviderError, RuntimeRunNotFoundError } from "../errors.ts";
import { K8sProvider, type K8sProviderDeps } from "./provider.ts";
import type { K8sInboxStore } from "./send-message.ts";

const coreApiThatThrows = (): CoreV1Api => {
	throw new Error("coreApi factory must not be called by sendMessage");
};

const handle: RunHandle = {
	runId: "run_steer",
	sandboxId: "run-run-steer",
	providerRunId: "pod-uid-1",
};

/** In-memory store that records enqueue inputs and can simulate a gone run. */
function fakeStore(opts: { runMissing?: boolean } = {}): {
	store: K8sInboxStore;
	calls: EnqueueRunInboxInput[];
} {
	const calls: EnqueueRunInboxInput[] = [];
	const store: K8sInboxStore = {
		async enqueue(input) {
			calls.push(input);
			if (opts.runMissing) return null;
			const row: RunInboxRow = {
				id: "msg_abcdefghjkmn",
				runId: input.runId,
				seq: 1,
				body: input.body,
				priority: input.priority ?? "normal",
				fromActor: input.fromActor ?? "operator",
				state: "unread",
				createdAt: "2026-07-12T00:00:00.000Z",
				deliveredAt: null,
			};
			return row;
		},
	};
	return { store, calls };
}

function provider(store: K8sInboxStore | undefined): K8sProvider {
	const deps: K8sProviderDeps = store
		? { coreApi: coreApiThatThrows, runInbox: () => store }
		: { coreApi: coreApiThatThrows };
	return new K8sProvider(deps);
}

describe("K8sProvider.sendMessage", () => {
	test("persists into run_inbox and returns the seam Message (unread ⇒ runId null)", async () => {
		const { store, calls } = fakeStore();
		const msg = await provider(store).sendMessage(handle, { body: "focus on the tests" });

		expect(calls).toEqual([{ runId: "run_steer", body: "focus on the tests" }]);
		expect(msg).toEqual({
			id: "msg_abcdefghjkmn",
			// Fresh send is unread ⇒ delivery attribution is null (LocalProvider parity).
			runId: null,
			body: "focus on the tests",
			priority: "normal",
			fromActor: "operator",
			state: "unread",
			createdAt: "2026-07-12T00:00:00.000Z",
			deliveredAt: null,
		});
	});

	test("forwards priority + fromActor only when supplied (no invented defaults)", async () => {
		const { store, calls } = fakeStore();
		await provider(store).sendMessage(handle, {
			body: "stop",
			priority: "urgent",
			fromActor: "watchdog",
		});
		expect(calls[0]).toEqual({
			runId: "run_steer",
			body: "stop",
			priority: "urgent",
			fromActor: "watchdog",
		});
	});

	test("addresses run_inbox by handle.runId, ignoring sandboxId (pod name)", async () => {
		const { store, calls } = fakeStore();
		await provider(store).sendMessage(
			{ runId: "run_target", sandboxId: "some-pod", providerRunId: "uid" },
			{ body: "hi" },
		);
		expect(calls[0]?.runId).toBe("run_target");
	});

	test("maps a gone run (store returns null) onto RuntimeRunNotFoundError", async () => {
		const { store } = fakeStore({ runMissing: true });
		await expect(provider(store).sendMessage(handle, { body: "ghost" })).rejects.toBeInstanceOf(
			RuntimeRunNotFoundError,
		);
	});

	test("raises RuntimeProviderError when no run_inbox store is wired", async () => {
		await expect(provider(undefined).sendMessage(handle, { body: "hi" })).rejects.toBeInstanceOf(
			RuntimeProviderError,
		);
	});
});

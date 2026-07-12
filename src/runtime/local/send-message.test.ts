/**
 * `LocalProvider.sendMessage()` — burrow's `POST /burrows/:id/inbox`
 * (`http.inbox.send`) wrapped as the seam's `sendMessage(handle, msg)`
 * (pl-829f step 10). Drives the real body against the burrow-client fetch-stub
 * fake so param construction (body/priority/fromActor, and the steer-identical
 * "omit when undefined" defaults), the burrow `Message`-row → seam `Message`
 * mapping, and error propagation are exercised with no real socket.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import {
	type BurrowFetchPlan,
	makeBurrowClient,
	makePool,
	type RecordedCall,
	setupRepos,
} from "../../runs/spawn/test-helpers.ts";
import type { OutboundMessage, RunHandle } from "../contract.ts";
import { RuntimeRunNotFoundError } from "../errors.ts";
import { LocalProvider } from "./provider.ts";

let openDb: WarrenDb | null = null;

afterEach(() => {
	openDb?.close();
	openDb = null;
});

async function repos(): Promise<Repos> {
	const { db, repos } = await setupRepos();
	openDb = db;
	return repos;
}

const HANDLE: RunHandle = {
	runId: "run_domain0001",
	sandboxId: "bur_aaaaaaaaaaaa",
	providerRunId: "run_zzzzzzzzzzzz",
};

async function localProvider(
	plan: BurrowFetchPlan = {},
): Promise<{ provider: LocalProvider; calls: RecordedCall[] }> {
	const r = await repos();
	const { client, calls } = makeBurrowClient(plan);
	const pool = await makePool(r, client);
	const provider = new LocalProvider({ burrowClient: () => pool });
	return { provider, calls };
}

/** The recorded `POST /burrows/:id/inbox` request (there is exactly one). */
function inboxCall(calls: RecordedCall[]): RecordedCall {
	const call = calls.find((c) => c.method === "POST" && /\/inbox$/.test(c.path));
	if (call === undefined) throw new Error("no inbox send call recorded");
	return call;
}

describe("LocalProvider.sendMessage — param mapping to inbox.send", () => {
	test("targets the burrow inbox (handle.sandboxId), sends body", async () => {
		const { provider, calls } = await localProvider();
		await provider.sendMessage(HANDLE, { body: "focus on the failing test" });
		const call = inboxCall(calls);
		expect(call.path).toBe("/burrows/bur_aaaaaaaaaaaa/inbox");
		expect(call.body).toEqual({ body: "focus on the failing test" });
	});

	test("forwards priority + fromActor when supplied", async () => {
		const { provider, calls } = await localProvider();
		const msg: OutboundMessage = {
			body: "urgent nudge",
			priority: "urgent",
			fromActor: "operator",
		};
		await provider.sendMessage(HANDLE, msg);
		expect(inboxCall(calls).body).toEqual({
			body: "urgent nudge",
			priority: "urgent",
			fromActor: "operator",
		});
	});

	test("omits priority/fromActor when undefined — identical to steer's defaults", async () => {
		const { provider, calls } = await localProvider();
		await provider.sendMessage(HANDLE, { body: "no extras" });
		const body = inboxCall(calls).body as Record<string, unknown>;
		// The provider invents NO defaults; burrow owns priority/fromActor
		// defaults server-side (preserving priority-desc-then-FIFO ordering).
		expect(Object.keys(body).sort()).toEqual(["body"]);
		expect("priority" in body).toBe(false);
		expect("fromActor" in body).toBe(false);
	});

	test("does NOT send handle.providerRunId — inbox is per-burrow", async () => {
		const { provider, calls } = await localProvider();
		await provider.sendMessage(HANDLE, { body: "hi" });
		const call = inboxCall(calls);
		expect(call.path).not.toContain("run_zzzzzzzzzzzz");
		expect(JSON.stringify(call.body)).not.toContain("run_zzzzzzzzzzzz");
	});
});

describe("LocalProvider.sendMessage — Message row mapping from response", () => {
	test("maps a fresh unread row: runId null, dates ISO, fields verbatim", async () => {
		const { provider } = await localProvider({
			inboxSend: {
				id: "msg_bbbbbbbbbbbb",
				body: "focus on the failing test",
				priority: "high",
				fromActor: "operator",
				state: "unread",
				deliveredAtRunId: null,
				createdAt: new Date("2026-05-08T12:00:10.000Z"),
				deliveredAt: null,
			},
		});
		const message = await provider.sendMessage(HANDLE, {
			body: "focus on the failing test",
			priority: "high",
		});
		expect(message).toEqual({
			id: "msg_bbbbbbbbbbbb",
			runId: null,
			body: "focus on the failing test",
			priority: "high",
			fromActor: "operator",
			state: "unread",
			createdAt: "2026-05-08T12:00:10.000Z",
			deliveredAt: null,
		});
	});

	test("surfaces burrow's deliveredAtRunId as runId + serializes deliveredAt", async () => {
		const { provider } = await localProvider({
			inboxSend: {
				id: "msg_cccccccccccc",
				state: "delivered",
				deliveredAtRunId: "run_claimed0001",
				createdAt: new Date("2026-05-08T12:00:10.000Z"),
				deliveredAt: new Date("2026-05-08T12:05:00.000Z"),
			},
		});
		const message = await provider.sendMessage(HANDLE, { body: "hi" });
		expect(message.runId).toBe("run_claimed0001");
		expect(message.state).toBe("delivered");
		expect(message.deliveredAt).toBe("2026-05-08T12:05:00.000Z");
	});

	test("preserves each priority verbatim across the mapping", async () => {
		for (const priority of ["low", "normal", "high", "urgent"] as const) {
			const { provider } = await localProvider({ inboxSend: { priority } });
			const message = await provider.sendMessage(HANDLE, { body: "p", priority });
			expect(message.priority).toBe(priority);
		}
	});
});

describe("LocalProvider.sendMessage — error propagation", () => {
	test("burrow NotFoundError is neutralized to RuntimeRunNotFoundError (warren-1f56)", async () => {
		const { provider } = await localProvider({
			inboxSendStatus: 404,
			inboxSendBody: { error: { code: "not_found", message: "burrow gone" } },
		});
		await expect(provider.sendMessage(HANDLE, { body: "hi" })).rejects.toBeInstanceOf(
			RuntimeRunNotFoundError,
		);
	});
});

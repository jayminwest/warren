import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { RunState } from "../core/wire.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RunTerminalState } from "../db/schema.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { RuntimeRunNotFoundError, RuntimeUnreachableError } from "../runtime/errors.ts";
import {
	type FakeProvider,
	type FakeProviderCall,
	makeFakeProvider,
} from "../runtime/fake/fake-provider.ts";
import { cancelRun } from "./cancel.ts";
import { RunEventBroker } from "./events.ts";
import type { ReapRunResult } from "./reap/index.ts";
import { makeReapRunResult } from "./reap/test-helpers.ts";

/**
 * The provider seam `cancelRun` speaks (warren-b223; re-based onto the
 * contract-typed `FakeProvider` in warren-ea0a when the burrow facade left).
 * `cancelRun` calls only `provider.cancel` / `provider.status`; the fake
 * records the cancel and reports the canned post-cancel phase, so the corner
 * cases below assert on the same provider-boundary behavior as before.
 */
async function makeProvider(client: FakeProvider, _repos: Repos): Promise<RuntimeProvider> {
	return client;
}

function reapStub(outcome: RunTerminalState): ReapRunResult {
	return makeReapRunResult({ state: outcome });
}

interface CancelFetchPlan {
	/** Post-cancel phase `provider.status` reports (default "cancelled"). */
	run?: { state?: RunState };
	/** 404 ⇒ backend run-not-found; 500 ⇒ a non-not-found backend failure. */
	status?: number;
}

function makeSandboxClient(plan: CancelFetchPlan = {}): {
	client: FakeProvider;
	calls: FakeProviderCall[];
} {
	const cancelError =
		plan.status === 404
			? new RuntimeRunNotFoundError("run not found: rb_a", {
					recoveryHint: "the run is unknown to the backend; terminalize the warren row",
				})
			: plan.status !== undefined
				? new Error("boom")
				: undefined;
	const client = makeFakeProvider({
		statusValue: {
			phase: plan.run?.state ?? "cancelled",
			exitCode: 0,
			lastEventSeq: 0,
			lastEventTs: null,
			exists: true,
		},
		...(cancelError !== undefined ? { cancelError } : {}),
	});
	return { client, calls: client.calls };
}

describe("cancelRun", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	async function createRun(
		opts: {
			sandboxId?: string | null;
			sandboxRunId?: string | null;
			state?: "queued" | "running";
		} = {},
	): Promise<string> {
		const sandboxId = opts.sandboxId === undefined ? "bur_aaaaaaaaaaaa" : opts.sandboxId;
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId,
			sandboxRunId: opts.sandboxRunId === undefined ? "run_zzzzzzzzzzzz" : opts.sandboxRunId,
		});
		if (opts.state === "running") await repos.runs.markRunning(run.id);
		return run.id;
	}

	test("throws NotFoundError when the run does not exist", async () => {
		const { client, calls } = makeSandboxClient();
		await expect(
			cancelRun({
				runId: "run_doesnotexist",
				repos,
				runtimeProvider: await makeProvider(client, repos),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("forwards the cancel through the provider and emits a cancel.requested event", async () => {
		const runId = await createRun({ state: "running" });
		const { client, calls } = makeSandboxClient();
		const reapCalls: { runId: string; outcome: string }[] = [];
		const result = await cancelRun({
			runId,
			reason: "operator changed their mind",
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async (input) => {
				reapCalls.push({ runId: input.runId, outcome: input.outcome });
				return reapStub(input.outcome);
			},
		});
		expect(result.alreadyTerminal).toBe(false);
		expect(result.sandboxRun?.state).toBe("cancelled");
		// The graceful cancel POST rides the seam (warren-1f56); the status
		// re-read (runs.get + events replay) follows it.
		expect(calls).toContainEqual({
			method: "POST",
			path: "/runs/run_zzzzzzzzzzzz/cancel",
			body: { reason: "operator changed their mind" },
		});
		const events = await repos.events.listByRun(runId);
		expect(events).toHaveLength(1);
		const event = events[0];
		if (!event) throw new Error("no event");
		expect(event.kind).toBe("cancel.requested");
		expect(event.stream).toBe("system");
		const payload = event.payloadJson as {
			reason: string;
			mode: string;
			sandboxRunId: string;
		};
		expect(payload.mode).toBe("forwarded");
		expect(payload.reason).toBe("operator changed their mind");
		expect(payload.sandboxRunId).toBe("run_zzzzzzzzzzzz");
		expect(reapCalls).toEqual([{ runId, outcome: "cancelled" }]);
	});

	test("warren-a7cb: forwards the active runtimeProvider into the inline reap", async () => {
		const runId = await createRun({ state: "running" });
		const provider = {
			cancel: async () => {},
			status: async () => ({
				phase: "cancelled" as const,
				exitCode: 0,
				lastEventSeq: 0,
				lastEventTs: null,
				exists: true,
			}),
		} as unknown as RuntimeProvider;
		const reapProviders: (RuntimeProvider | undefined)[] = [];
		await cancelRun({
			runId,
			repos,
			runtimeProvider: provider,
			reap: async (input) => {
				reapProviders.push(input.runtimeProvider);
				return reapStub(input.outcome);
			},
		});
		// The reap saw the SAME provider, so finalize + terminate run through the
		// active backend rather than a default burrow-backed LocalProvider.
		expect(reapProviders).toEqual([provider]);
	});

	test("warren-a69a: terminal burrow state triggers reap inline", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeSandboxClient();
		const reapCalls: { runId: string; outcome: string }[] = [];
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async (input) => {
				reapCalls.push({ runId: input.runId, outcome: input.outcome });
				return reapStub(input.outcome);
			},
		});
		expect(reapCalls).toEqual([{ runId, outcome: "cancelled" }]);
		expect(result.state).toBe("cancelled");
	});

	test("warren-a69a: succeeded burrow state also triggers reap (graceful exit during cancel)", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeSandboxClient({ run: { state: "succeeded" } });
		const reapCalls: { runId: string; outcome: string }[] = [];
		await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async (input) => {
				reapCalls.push({ runId: input.runId, outcome: input.outcome });
				return reapStub(input.outcome);
			},
		});
		expect(reapCalls).toEqual([{ runId, outcome: "succeeded" }]);
	});

	test("warren-a69a: non-terminal burrow state does not trigger reap", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeSandboxClient({ run: { state: "running" } });
		const reapCalls: { runId: string }[] = [];
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async (input) => {
				reapCalls.push({ runId: input.runId });
				return reapStub("cancelled");
			},
		});
		expect(reapCalls).toEqual([]);
		expect(result.state).toBe("running");
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("warren-a69a: reap throwing does not escape; cancel still returns the burrow run", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeSandboxClient();
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async () => {
				throw new Error("disk full");
			},
		});
		expect(result.sandboxRun?.state).toBe("cancelled");
		// reap was attempted but threw — warren state is unchanged.
		expect(result.state).toBe("running");
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("omits the reason field on the wire when unset", async () => {
		const runId = await createRun({ state: "running" });
		const { client, calls } = makeSandboxClient();
		await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async (input) => reapStub(input.outcome),
		});
		expect(calls[0]?.body).toBeUndefined();
	});

	test("returns idempotently when the run is already terminal", async () => {
		const runId = await createRun({ state: "running" });
		await repos.runs.finalize(runId, "succeeded");
		const { client, calls } = makeSandboxClient();
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.alreadyTerminal).toBe(true);
		expect(result.state).toBe("succeeded");
		expect(result.sandboxRun).toBeNull();
		expect(calls).toHaveLength(0);
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("queued run with no sandbox_run_id is cancelled in warren without a wire call", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: null,
		});
		const { client, calls } = makeSandboxClient();
		const result = await cancelRun({
			runId: run.id,
			reason: "abort",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.alreadyTerminal).toBe(false);
		expect(result.sandboxRun).toBeNull();
		expect(result.state).toBe("cancelled");
		expect(calls).toHaveLength(0);
		expect((await repos.runs.require(run.id)).state).toBe("cancelled");
		const events = await repos.events.listByRun(run.id);
		expect(events).toHaveLength(1);
		const event = events[0];
		if (!event) throw new Error("no event");
		expect(event.kind).toBe("cancel.requested");
		const payload = event.payloadJson as { mode: string; reason: string };
		expect(payload.mode).toBe("warren_only");
		expect(payload.reason).toBe("abort");
	});

	test("rejects a running run with no sandbox_run_id (impossible state)", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: null,
		});
		await repos.runs.markRunning(run.id);
		const { client, calls } = makeSandboxClient();
		await expect(
			cancelRun({ runId: run.id, repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("publishes the audit event to the broker", async () => {
		const runId = await createRun({ state: "running" });
		const broker = new RunEventBroker();
		const sub = broker.subscribe(runId);
		const consumed: string[] = [];
		const consumer = (async () => {
			for await (const row of sub) {
				consumed.push(row.kind);
				if (consumed.length >= 1) break;
			}
		})();
		const { client } = makeSandboxClient();
		await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			broker,
			reap: async (input) => reapStub(input.outcome),
		});
		await consumer;
		expect(consumed).toEqual(["cancel.requested"]);
	});

	test("audit event seq starts at MAX(seq) + 1 when prior events exist", async () => {
		const runId = await createRun({ state: "running" });
		await repos.events.append({
			runId,
			sandboxEventSeq: 12,
			ts: "2026-05-08T12:00:00Z",
			kind: "text",
			stream: "stdout",
			payload: {},
		});
		const { client } = makeSandboxClient();
		await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async (input) => reapStub(input.outcome),
		});
		const events = await repos.events.listByRun(runId);
		const requested = events.find((e) => e.kind === "cancel.requested");
		expect(requested?.sandboxEventSeq).toBe(13);
	});

	test("transport errors surface as RuntimeUnreachableError", async () => {
		const runId = await createRun({ state: "running" });
		const client = makeFakeProvider({
			cancelError: new RuntimeUnreachableError("fetch failed"),
		});
		await expect(
			cancelRun({ runId, repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toBeInstanceOf(RuntimeUnreachableError);
		// No audit event was emitted, and the run is still running.
		expect(await repos.events.countByRun(runId)).toBe(0);
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("warren-b1a9: backend run-not-found reconciles the run to failed/sandbox_run_lost", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeSandboxClient({ status: 404 });
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.state).toBe("failed");
		expect(result.sandboxRun).toBeNull();
		expect(result.alreadyTerminal).toBe(false);
		const run = await repos.runs.require(runId);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("sandbox_run_lost");
		// Audit event landed describing the reconciliation.
		const events = await repos.events.listByRun(runId);
		expect(events.length).toBe(1);
		expect(events[0]?.kind).toBe("cancel.requested");
		expect((events[0]?.payloadJson as { mode: string }).mode).toBe("sandbox_run_lost");
	});

	test("non-not-found backend errors still propagate without emitting an audit event", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeSandboxClient({ status: 500 });
		await expect(
			cancelRun({ runId, repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toThrow();
		expect(await repos.events.countByRun(runId)).toBe(0);
	});
});

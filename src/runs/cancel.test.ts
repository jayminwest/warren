import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowUnreachableError } from "../burrow-client/index.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RunTerminalState } from "../db/schema.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { resolveRuntimeProvider } from "../runtime/registry.ts";
import { cancelRun } from "./cancel.ts";
import { RunEventBroker } from "./events.ts";
import type { ReapRunResult } from "./reap/index.ts";
import { makeReapRunResult } from "./reap/test-helpers.ts";

/**
 * One-worker pool wired to a stub burrow client (warren-c0c9). Upserts a
 * `local` worker row so `pool.clientFor` resolves cleanly.
 */
async function makePool(
	client: BurrowClient,
	_repos: Repos,
	_workerName = "local",
): Promise<BurrowClient> {
	return client;
}

/**
 * Build the runtime-provider seam over the single-`local`-worker pool
 * (pl-829f step 13 / warren-b223). `cancelRun` speaks only `provider.cancel` /
 * `provider.status` now; the real LocalProvider still resolves the sole burrow
 * worker and drives the same burrow HTTP the pre-seam client did, so the corner
 * cases below assert on the exact same wire the stub records.
 */
async function makeProvider(client: BurrowClient, repos: Repos): Promise<RuntimeProvider> {
	const pool = await makePool(client, repos);
	return resolveRuntimeProvider({ burrowClient: () => pool });
}

function reapStub(outcome: RunTerminalState): ReapRunResult {
	return makeReapRunResult({ state: outcome });
}

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

interface CancelFetchPlan {
	run?: Partial<BurrowRun>;
	status?: number;
	body?: unknown;
}

function makeBurrowClient(plan: CancelFetchPlan = {}): {
	client: BurrowClient;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const run: BurrowRun = {
		id: "run_zzzzzzzzzzzz",
		burrowId: "bur_aaaaaaaaaaaa",
		agentId: "refactor-bot",
		prompt: "p",
		resumeOfRunId: null,
		state: "cancelled",
		exitCode: null,
		errorMessage: null,
		metadataJson: null,
		queuedAt: new Date("2026-05-08T12:00:00Z"),
		startedAt: null,
		completedAt: new Date("2026-05-08T12:00:01Z"),
		...plan.run,
	};
	const fetchImpl = stub(async (input, init) => {
		const url = new URL(String(input), "http://localhost");
		const path = url.pathname;
		const method = init?.method ?? "GET";
		const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body: reqBody });
		if (method === "POST" && path.match(/^\/runs\/[^/]+\/cancel$/)) {
			return jsonResponse(plan.status ?? 200, plan.body ?? serializeRun(run));
		}
		// warren-1f56: cancel now re-reads the post-cancel phase via
		// `provider.status()`, which drives `runs.get` + a bounded `events`
		// replay. Route both so the status snapshot resolves against the same
		// (post-cancel) run row.
		if (method === "GET" && /^\/burrows\/[^/]+\/events$/.test(path)) {
			return new Response("", { status: 200, headers: { "content-type": "application/x-ndjson" } });
		}
		if (method === "GET" && /^\/runs\/[^/]+$/.test(path)) {
			return jsonResponse(200, serializeRun(run));
		}
		return jsonResponse(404, {
			error: { code: "not_found", message: `unmatched ${method} ${path}` },
		});
	});
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: fetchImpl,
	});
	return { client, calls };
}

function serializeRun(r: BurrowRun): unknown {
	return {
		...r,
		queuedAt: r.queuedAt.toISOString(),
		startedAt: r.startedAt?.toISOString() ?? null,
		completedAt: r.completedAt?.toISOString() ?? null,
	};
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
			burrowId?: string | null;
			burrowRunId?: string | null;
			state?: "queued" | "running";
		} = {},
	): Promise<string> {
		const burrowId = opts.burrowId === undefined ? "bur_aaaaaaaaaaaa" : opts.burrowId;
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId,
			burrowRunId: opts.burrowRunId === undefined ? "run_zzzzzzzzzzzz" : opts.burrowRunId,
		});
		if (opts.state === "running") await repos.runs.markRunning(run.id);
		return run.id;
	}

	test("throws NotFoundError when the run does not exist", async () => {
		const { client, calls } = makeBurrowClient();
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
		const { client, calls } = makeBurrowClient();
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
		expect(result.burrowRun?.state).toBe("cancelled");
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
			burrowRunId: string;
		};
		expect(payload.mode).toBe("forwarded");
		expect(payload.reason).toBe("operator changed their mind");
		expect(payload.burrowRunId).toBe("run_zzzzzzzzzzzz");
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
		const { client } = makeBurrowClient();
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
		const { client } = makeBurrowClient({ run: { state: "succeeded" } });
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
		const { client } = makeBurrowClient({ run: { state: "running" } });
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
		const { client } = makeBurrowClient();
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async () => {
				throw new Error("disk full");
			},
		});
		expect(result.burrowRun?.state).toBe("cancelled");
		// reap was attempted but threw — warren state is unchanged.
		expect(result.state).toBe("running");
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("omits the reason field on the wire when unset", async () => {
		const runId = await createRun({ state: "running" });
		const { client, calls } = makeBurrowClient();
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
		const { client, calls } = makeBurrowClient();
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.alreadyTerminal).toBe(true);
		expect(result.state).toBe("succeeded");
		expect(result.burrowRun).toBeNull();
		expect(calls).toHaveLength(0);
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("queued run with no burrow_run_id is cancelled in warren without a wire call", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: null,
		});
		const { client, calls } = makeBurrowClient();
		const result = await cancelRun({
			runId: run.id,
			reason: "abort",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.alreadyTerminal).toBe(false);
		expect(result.burrowRun).toBeNull();
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

	test("rejects a running run with no burrow_run_id (impossible state)", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: null,
		});
		await repos.runs.markRunning(run.id);
		const { client, calls } = makeBurrowClient();
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
		const { client } = makeBurrowClient();
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
			burrowEventSeq: 12,
			ts: "2026-05-08T12:00:00Z",
			kind: "text",
			stream: "stdout",
			payload: {},
		});
		const { client } = makeBurrowClient();
		await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
			reap: async (input) => reapStub(input.outcome),
		});
		const events = await repos.events.listByRun(runId);
		const requested = events.find((e) => e.kind === "cancel.requested");
		expect(requested?.burrowEventSeq).toBe(13);
	});

	test("transport errors are mapped to BurrowUnreachableError", async () => {
		const runId = await createRun({ state: "running" });
		const fetchImpl = stub(async () => {
			throw new TypeError("fetch failed");
		});
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: fetchImpl,
		});
		await expect(
			cancelRun({ runId, repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toBeInstanceOf(BurrowUnreachableError);
		// No audit event was emitted, and the run is still running.
		expect(await repos.events.countByRun(runId)).toBe(0);
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("warren-b1a9: backend run-not-found reconciles the run to failed/burrow_run_lost", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeBurrowClient({
			status: 404,
			body: { error: { code: "not_found", message: "run not found: rb_a" } },
		});
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.state).toBe("failed");
		expect(result.burrowRun).toBeNull();
		expect(result.alreadyTerminal).toBe(false);
		const run = await repos.runs.require(runId);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("burrow_run_lost");
		// Audit event landed describing the reconciliation.
		const events = await repos.events.listByRun(runId);
		expect(events.length).toBe(1);
		expect(events[0]?.kind).toBe("cancel.requested");
		expect((events[0]?.payloadJson as { mode: string }).mode).toBe("burrow_run_lost");
	});

	test("non-not-found backend errors still propagate without emitting an audit event", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeBurrowClient({
			status: 500,
			body: { error: { code: "internal", message: "boom" } },
		});
		await expect(
			cancelRun({ runId, repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toThrow();
		expect(await repos.events.countByRun(runId)).toBe(0);
	});
});

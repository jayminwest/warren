import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool, BurrowUnreachableError } from "../burrow-client/index.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RunTerminalState } from "../db/schema.ts";
import { cancelRun } from "./cancel.ts";
import { RunEventBroker } from "./events.ts";
import type { ReapRunResult } from "./reap/index.ts";

/**
 * One-worker pool wired to a stub burrow client (warren-c0c9). Upserts a
 * `local` worker row so `pool.clientFor` resolves cleanly.
 */
async function makePool(
	client: BurrowClient,
	repos: Repos,
	workerName = "local",
): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: workerName, url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register(workerName, client);
	return pool;
}

function reapStub(outcome: RunTerminalState): ReapRunResult {
	return {
		state: outcome,
		failureReason: null,
		mulchUpdated: 0,
		mulchSkipped: 0,
		mulchAppended: 0,
		seedsClosed: 0,
		seedsCreated: 0,
		plotEventsAppended: 0,
		plotsUpdated: 0,
		plotEventsMirrored: 0,
		plotCommitted: false,
		seedsCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		prUrl: null,
		previewState: null,
		previewPort: null,
		previewUrl: null,
		autoPlanRunCreated: false,
		autoPlanRunId: null,
		autoPlanRunPlanId: null,
		errors: [],
		alreadyTerminal: false,
	};
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
	const fetchImpl = stub(async (input, init) => {
		const url = new URL(String(input), "http://localhost");
		const path = url.pathname;
		const method = init?.method ?? "GET";
		const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body: reqBody });
		if (method === "POST" && path.match(/^\/runs\/[^/]+\/cancel$/)) {
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
			return jsonResponse(plan.status ?? 200, plan.body ?? serializeRun(run));
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
		if (burrowId !== null && (await repos.burrows.get(burrowId)) === null) {
			await repos.burrows.create({ id: burrowId, workerId: "local" });
		}
		return run.id;
	}

	test("throws NotFoundError when the run does not exist", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			cancelRun({
				runId: "run_doesnotexist",
				repos,
				burrowClientPool: await makePool(client, repos),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("forwards the cancel to burrow and emits a cancel.requested event", async () => {
		const runId = await createRun({ state: "running" });
		const { client, calls } = makeBurrowClient();
		const reapCalls: { runId: string; outcome: string }[] = [];
		const result = await cancelRun({
			runId,
			reason: "operator changed their mind",
			repos,
			burrowClientPool: await makePool(client, repos),
			reap: async (input) => {
				reapCalls.push({ runId: input.runId, outcome: input.outcome });
				return reapStub(input.outcome);
			},
		});
		expect(result.alreadyTerminal).toBe(false);
		expect(result.burrowRun?.state).toBe("cancelled");
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/runs/run_zzzzzzzzzzzz/cancel",
				body: { reason: "operator changed their mind" },
			},
		]);
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

	test("warren-a69a: terminal burrow state triggers reap inline", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeBurrowClient();
		const reapCalls: { runId: string; outcome: string }[] = [];
		const result = await cancelRun({
			runId,
			repos,
			burrowClientPool: await makePool(client, repos),
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
			burrowClientPool: await makePool(client, repos),
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
			burrowClientPool: await makePool(client, repos),
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
			burrowClientPool: await makePool(client, repos),
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
		await cancelRun({ runId, repos, burrowClientPool: await makePool(client, repos) });
		expect(calls[0]?.body).toBeUndefined();
	});

	test("returns idempotently when the run is already terminal", async () => {
		const runId = await createRun({ state: "running" });
		await repos.runs.finalize(runId, "succeeded");
		const { client, calls } = makeBurrowClient();
		const result = await cancelRun({
			runId,
			repos,
			burrowClientPool: await makePool(client, repos),
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
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		const { client, calls } = makeBurrowClient();
		const result = await cancelRun({
			runId: run.id,
			reason: "abort",
			repos,
			burrowClientPool: await makePool(client, repos),
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
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		const { client, calls } = makeBurrowClient();
		await expect(
			cancelRun({ runId: run.id, repos, burrowClientPool: await makePool(client, repos) }),
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
		await cancelRun({ runId, repos, burrowClientPool: await makePool(client, repos), broker });
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
		await cancelRun({ runId, repos, burrowClientPool: await makePool(client, repos) });
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
			cancelRun({ runId, repos, burrowClientPool: await makePool(client, repos) }),
		).rejects.toBeInstanceOf(BurrowUnreachableError);
		// No audit event was emitted, and the run is still running.
		expect(await repos.events.countByRun(runId)).toBe(0);
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("warren-b1a9: burrow 404 reconciles the run to failed/burrow_run_lost", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeBurrowClient({
			status: 404,
			body: { error: { code: "not_found", message: "run not found: rb_a" } },
		});
		const result = await cancelRun({
			runId,
			repos,
			burrowClientPool: await makePool(client, repos),
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

	test("non-404 burrow errors still propagate without emitting an audit event", async () => {
		const runId = await createRun({ state: "running" });
		const { client } = makeBurrowClient({
			status: 500,
			body: { error: { code: "internal", message: "boom" } },
		});
		await expect(
			cancelRun({ runId, repos, burrowClientPool: await makePool(client, repos) }),
		).rejects.toThrow();
		expect(await repos.events.countByRun(runId)).toBe(0);
	});
});

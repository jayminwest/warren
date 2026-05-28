import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type {
	CreatePlotRequest,
	CreatePlotResult,
	PlotAggregator,
	PlotCreator,
	PlotSummary,
} from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";

const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
};

function stubFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function poolFor(repos: Repos): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stubFetch(async () => jsonRes(404, { error: { code: "not_found", message: "stub" } })),
	});
	pool.register("local", client);
	return pool;
}

interface BuildDepsInput {
	repos: Repos;
	plotAggregator?: PlotAggregator;
	plotCreator?: PlotCreator;
}

async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const pool = await poolFor(input.repos);
	return {
		repos: input.repos,
		burrowClientPool: pool,
		broker,
		bridges: createBridgeRegistry({
			repos: input.repos,
			broker,
			burrowClientPool: pool,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(input.plotAggregator !== undefined ? { plotAggregator: input.plotAggregator } : {}),
		...(input.plotCreator !== undefined ? { plotCreator: input.plotCreator } : {}),
	};
}

interface FakeCreatorCall {
	readonly input: CreatePlotRequest;
}

function fakeCreator(result: CreatePlotResult): {
	creator: PlotCreator;
	calls: FakeCreatorCall[];
} {
	const calls: FakeCreatorCall[] = [];
	const creator: PlotCreator = {
		async create(input) {
			calls.push({ input });
			return result;
		},
	};
	return { creator, calls };
}

async function seedProject(
	repos: Repos,
	over: Partial<ProjectRow> & { id: string },
): Promise<ProjectRow> {
	return repos.projects.create({
		id: over.id,
		gitUrl: over.gitUrl ?? `https://example.test/${over.id}.git`,
		defaultBranch: over.defaultBranch ?? "main",
		localPath: over.localPath ?? `/tmp/projects/${over.id}`,
		hasPlot: over.hasPlot ?? false,
		hasSeeds: over.hasSeeds ?? false,
	});
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

interface FakeAggregatorCalls {
	calls: Array<{ status?: string }>;
	invalidates: Array<string | undefined>;
}

function fakeAggregator(rows: readonly PlotSummary[]): {
	agg: PlotAggregator;
	state: FakeAggregatorCalls;
} {
	const state: FakeAggregatorCalls = { calls: [], invalidates: [] };
	const agg: PlotAggregator = {
		async listSummaries(q) {
			state.calls.push({ ...(q?.status !== undefined ? { status: q.status } : {}) });
			if (q?.status !== undefined) {
				return rows.filter((r) => r.status === q.status);
			}
			return rows;
		},
		async listNeedsAttention() {
			return [];
		},
		async countNeedsAttention() {
			return 0;
		},
		invalidate(projectId) {
			state.invalidates.push(projectId);
		},
	};
	return { agg, state };
}

function summary(over: Partial<PlotSummary>): PlotSummary {
	return {
		id: "pt-a",
		name: "A",
		status: "active",
		intent_goal_preview: "",
		attachments_count: 0,
		last_event_ts: "2026-05-18T00:00:00Z",
		last_event_actor: "user:operator",
		project_id: "proj-a",
		...over,
	};
}

describe("GET /plots", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("returns 200 { plots: [] } when no aggregator is wired (empty-deployments contract)", async () => {
		const deps = await depsFor({ repos });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plots: readonly PlotSummary[] };
		expect(body.plots).toEqual([]);
	});

	test("returns 200 { plots: [] } when the aggregator reports zero hasPlot projects", async () => {
		const { agg } = fakeAggregator([]);
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(`{"plots":[]}`);
	});

	test("surfaces aggregator rows as-is under the `plots` key", async () => {
		const rows = [
			summary({ id: "pt-1", status: "active", last_event_ts: "2026-05-18T01:00:00Z" }),
			summary({ id: "pt-2", status: "drafting", last_event_ts: "2026-05-18T00:30:00Z" }),
		];
		const { agg, state } = fakeAggregator(rows);
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plots: readonly PlotSummary[] };
		expect(body.plots.map((p) => p.id)).toEqual(["pt-1", "pt-2"]);
		expect(state.calls).toEqual([{}]);
	});

	test("passes ?status= through to the aggregator", async () => {
		const rows = [
			summary({ id: "pt-1", status: "active" }),
			summary({ id: "pt-2", status: "drafting" }),
		];
		const { agg, state } = fakeAggregator(rows);
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots?status=active`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plots: readonly PlotSummary[] };
		expect(body.plots.map((p) => p.id)).toEqual(["pt-1"]);
		expect(state.calls).toEqual([{ status: "active" }]);
	});

	test("treats empty ?status= as no filter", async () => {
		const rows = [summary({ id: "pt-1", status: "active" })];
		const { agg, state } = fakeAggregator(rows);
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots?status=`);
		expect(res.status).toBe(200);
		expect(state.calls).toEqual([{}]);
	});

	test("rejects unknown ?status= with 400 + validation_error", async () => {
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots?status=bogus`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("bogus");
		expect(state.calls).toEqual([]);
	});
});

describe("GET /plots?filter=needs_attention", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	function needsAttentionAggregator(
		rows: ReadonlyArray<
			PlotSummary & {
				reasons: ReadonlyArray<"paused_run" | "merged_pr_unreviewed" | "stale_draft">;
			}
		>,
	): PlotAggregator {
		return {
			async listSummaries() {
				return rows;
			},
			async listNeedsAttention() {
				return rows;
			},
			async countNeedsAttention() {
				return rows.length;
			},
			invalidate() {},
		};
	}

	test("returns aggregator listNeedsAttention rows under the `plots` key", async () => {
		const rows = [
			{ ...summary({ id: "pt-1", status: "active" }), reasons: ["paused_run"] as const },
			{
				...summary({ id: "pt-2", status: "drafting" }),
				reasons: ["stale_draft"] as const,
			},
		];
		const agg = needsAttentionAggregator(rows);
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots?filter=needs_attention`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			plots: ReadonlyArray<PlotSummary & { reasons: string[] }>;
		};
		expect(body.plots.map((r) => r.id)).toEqual(["pt-1", "pt-2"]);
		expect(body.plots[0]?.reasons).toEqual(["paused_run"]);
	});

	test("composes ?status= on top of ?filter=needs_attention", async () => {
		const rows = [
			{ ...summary({ id: "pt-1", status: "active" }), reasons: ["paused_run"] as const },
			{
				...summary({ id: "pt-2", status: "drafting" }),
				reasons: ["stale_draft"] as const,
			},
		];
		const agg = needsAttentionAggregator(rows);
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots?filter=needs_attention&status=drafting`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plots: ReadonlyArray<PlotSummary> };
		expect(body.plots.map((r) => r.id)).toEqual(["pt-2"]);
	});

	test("rejects unknown ?filter= with 400 validation_error", async () => {
		const agg = needsAttentionAggregator([]);
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots?filter=bogus`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("bogus");
	});

	test("empty body when aggregator is not wired", async () => {
		const deps = await depsFor({ repos });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots?filter=needs_attention`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plots: ReadonlyArray<PlotSummary> };
		expect(body.plots).toEqual([]);
	});
});

describe("GET /plots/needs-attention/count", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("returns `{ count }` mirroring the aggregator", async () => {
		const agg: PlotAggregator = {
			async listSummaries() {
				return [];
			},
			async listNeedsAttention() {
				return [];
			},
			async countNeedsAttention() {
				return 3;
			},
			invalidate() {},
		};
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/needs-attention/count`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { count: number };
		expect(body.count).toBe(3);
	});

	test("returns `{ count: 0 }` when aggregator is not wired (empty-deployment contract)", async () => {
		const deps = await depsFor({ repos });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/needs-attention/count`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(`{"count":0}`);
	});

	test("does NOT shadow GET /plots/:id when the param is 'needs-attention'", async () => {
		const agg: PlotAggregator = {
			async listSummaries() {
				return [];
			},
			async listNeedsAttention() {
				return [];
			},
			async countNeedsAttention() {
				return 0;
			},
			invalidate() {},
		};
		const deps = await depsFor({ repos, plotAggregator: agg });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/needs-attention`);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
	});
});

describe("POST /plots", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	const HAPPY_RESULT: CreatePlotResult = {
		id: "pt-new",
		name: "Fresh Plot",
		status: "drafting",
		intent_goal_preview: "ship it",
		attachments_count: 0,
		last_event_ts: "2026-05-18T01:23:45Z",
		last_event_actor: "user:operator",
	};

	test("happy path: creates a Plot in a hasPlot project and returns the PlotSummary", async () => {
		const project = await seedProject(repos, { id: "proj-plot", hasPlot: true });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({ repos, plotAggregator: agg, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: project.id,
				name: "Fresh Plot",
				intent: { goal: "ship it", non_goals: ["yak shave"] },
				dispatcher_handle: "alice",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as PlotSummary;
		expect(body).toEqual({
			id: "pt-new",
			name: "Fresh Plot",
			status: "drafting",
			intent_goal_preview: "ship it",
			attachments_count: 0,
			last_event_ts: "2026-05-18T01:23:45Z",
			last_event_actor: "user:operator",
			project_id: project.id,
		});

		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one creator call");
		expect(call.input.handle).toBe("alice");
		expect(call.input.name).toBe("Fresh Plot");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);
		expect(call.input.intent).toEqual({ goal: "ship it", non_goals: ["yak shave"] });

		expect(state.invalidates).toEqual([project.id]);
	});

	test("rejects when project.hasPlot=false with ProjectLacksPlotError", async () => {
		const project = await seedProject(repos, { id: "proj-noplot", hasPlot: false });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id, name: "Won't land" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(body.error.message).toContain(project.id);
		expect(calls).toEqual([]);
	});

	test("404s on unknown project_id", async () => {
		const deps = await depsFor({ repos, plotCreator: fakeCreator(HAPPY_RESULT).creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: "prj-missing", name: "x" }),
		});
		expect(res.status).toBe(404);
	});

	test("defaults missing name to 'Untitled Plot'", async () => {
		const project = await seedProject(repos, { id: "proj-untitled", hasPlot: true });
		const { creator, calls } = fakeCreator({ ...HAPPY_RESULT, name: "Untitled Plot" });
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id }),
		});
		expect(res.status).toBe(201);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one creator call");
		expect(call.input.name).toBe("Untitled Plot");
		expect(call.input.intent).toBeUndefined();
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-handle", hasPlot: true });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: project.id,
				name: "x",
				dispatcher_handle: "!!not a handle!!",
			}),
		});
		expect(res.status).toBe(201);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one creator call");
		expect(call.input.handle).toBe("operator");
	});

	test("rejects empty string name with 400", async () => {
		const project = await seedProject(repos, { id: "proj-emptyname", hasPlot: true });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id, name: "   " }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects unknown intent field with 400", async () => {
		const project = await seedProject(repos, { id: "proj-badintent", hasPlot: true });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: project.id,
				name: "x",
				intent: { goal: "ok", nongoals: ["typo"] },
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.message).toContain("nongoals");
		expect(calls).toEqual([]);
	});

	test("propagates creator errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const boom: PlotCreator = {
			async create() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({ repos, plotCreator: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id, name: "x" }),
		});
		expect(res.status).toBe(500);
	});
});

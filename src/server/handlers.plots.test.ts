/**
 * `handlers.plots.test.ts` covers `GET /plots`
 * (warren-c167 / pl-9d6a step 2).
 *
 * Pins:
 *   - empty-deployments contract: when no project has `hasPlot=true` (or
 *     when no aggregator is wired) the handler returns
 *     `200 { plots: [] }` — the byte-identical empty-array shape the
 *     standalone-warren framing depends on.
 *   - status filter is passed through to the aggregator, with the
 *     `@os-eco/plot-cli` `PLOT_STATUSES` whitelist gating obvious typos
 *     at the handler edge (400 + `bad_request`).
 *   - the aggregated rows the aggregator returns surface as-is on the
 *     wire under the `plots` key.
 *
 * The live `UserPlotClient` round-trip is exercised by scenario 28
 * (warren-5b8a). Here we stub at the `PlotAggregator` seam exposed via
 * `ServerDeps.plotAggregator`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Attachment, Intent, PlotEvent } from "@os-eco/plot-cli";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ProjectRow } from "../db/schema.ts";
import type {
	CreatePlotRequest,
	CreatePlotResult,
	PlotAggregator,
	PlotCreator,
	PlotEnvelope,
	PlotReader,
	PlotResolver,
	PlotSummary,
	ReadPlotRequest,
	ReadPlotResult,
} from "../plots/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { Logger, ServeHandle, ServerDeps } from "./types.ts";

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
	plotReader?: PlotReader;
	plotResolver?: PlotResolver;
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
		...(input.plotReader !== undefined ? { plotReader: input.plotReader } : {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
	};
}

interface FakeReaderCall {
	readonly input: ReadPlotRequest;
}

function fakeReader(result: ReadPlotResult): { reader: PlotReader; calls: FakeReaderCall[] } {
	const calls: FakeReaderCall[] = [];
	const reader: PlotReader = {
		async read(input) {
			calls.push({ input });
			return result;
		},
	};
	return { reader, calls };
}

function fakeResolver(map: Record<string, ProjectRow | null>): {
	resolver: PlotResolver;
	calls: string[];
} {
	const calls: string[] = [];
	const resolver: PlotResolver = {
		async resolve(plotId) {
			calls.push(plotId);
			return map[plotId] ?? null;
		},
	};
	return { resolver, calls };
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

		// Aggregator cache was invalidated for the owning project.
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
		// Generic error → 500 (no typed mapping); the user sees the failure
		// synchronously rather than the create silently succeeding-with-warning.
		expect(res.status).toBe(500);
	});
});

describe("GET /plots/:id", () => {
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

	const intent: Intent = {
		goal: "ship it",
		non_goals: ["yak shave"],
		constraints: [],
		success_criteria: ["green CI"],
	};

	const attachments: Attachment[] = [
		{
			id: "att-001",
			type: "seeds_issue",
			ref: "warren-961e",
			role: "primary",
			added_at: "2026-05-18T01:00:00Z",
			added_by: "user:alice",
		},
	];

	const events: PlotEvent[] = [
		{
			type: "plot_created",
			actor: "user:alice",
			at: "2026-05-18T01:00:00Z",
			data: { name: "P" },
		},
		{
			type: "note",
			actor: "user:alice",
			at: "2026-05-18T01:30:00Z",
			data: { text: "second" },
		},
	];

	const READ_RESULT: ReadPlotResult = {
		id: "pt-xyz",
		name: "P",
		status: "active",
		intent,
		attachments,
		event_log: events,
	};

	test("happy path: returns full envelope with project_id stitched on", async () => {
		const project = await seedProject(repos, { id: "proj-plot", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-xyz": project });
		const { reader, calls: readerCalls } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-xyz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PlotEnvelope;
		expect(body.id).toBe("pt-xyz");
		expect(body.name).toBe("P");
		expect(body.status).toBe("active");
		expect(body.intent).toEqual(intent);
		expect(body.attachments).toEqual(attachments);
		expect(body.event_log).toEqual(events);
		expect(body.project_id).toBe(project.id);

		expect(resolverCalls).toEqual(["pt-xyz"]);
		expect(readerCalls).toHaveLength(1);
		const call = readerCalls[0];
		if (call === undefined) throw new Error("expected one reader call");
		expect(call.input.plotId).toBe("pt-xyz");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);
	});

	test("404s when the resolver returns null (unknown plot_id)", async () => {
		const { resolver } = fakeResolver({});
		const { reader, calls } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("not_found");
		expect(body.error.message).toContain("pt-missing");
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const deps = await depsFor({ repos });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-anything`);
		expect(res.status).toBe(404);
	});

	test("surfaces ProjectLacksPlotError defensively when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flipped", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flipped": project });
		const { reader, calls } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flipped`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(body.error.message).toContain(project.id);
		expect(calls).toEqual([]);
	});

	test("propagates reader errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-boom": project });
		const boom: PlotReader = {
			async read() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-boom`);
		expect(res.status).toBe(500);
	});
});

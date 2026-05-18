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
import type { Attachment, Intent, PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ProjectRow } from "../db/schema.ts";
import {
	PlotAttachmentNotFoundError,
	PlotIllegalStatusTransitionError,
	PlotIntentFrozenError,
} from "../plots/errors.ts";
import type {
	AttachPlotRequest,
	AttachPlotResult,
	ChangePlotStatusRequest,
	ChangePlotStatusResult,
	CreatePlotRequest,
	CreatePlotResult,
	DetachPlotRequest,
	DetachPlotResult,
	EditPlotIntentRequest,
	EditPlotIntentResult,
	PlotAggregator,
	PlotAttacher,
	PlotCreator,
	PlotEnvelope,
	PlotIntentEditor,
	PlotReader,
	PlotResolver,
	PlotStatusChanger,
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
	plotIntentEditor?: PlotIntentEditor;
	plotStatusChanger?: PlotStatusChanger;
	plotAttacher?: PlotAttacher;
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
		...(input.plotIntentEditor !== undefined ? { plotIntentEditor: input.plotIntentEditor } : {}),
		...(input.plotStatusChanger !== undefined
			? { plotStatusChanger: input.plotStatusChanger }
			: {}),
		...(input.plotAttacher !== undefined ? { plotAttacher: input.plotAttacher } : {}),
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

/* ----------------------------------------------------------------------- */
/* POST /plots/:id/intent (warren-896f / pl-9d6a step 9)                    */
/* ----------------------------------------------------------------------- */

interface FakeIntentEditorCall {
	readonly input: EditPlotIntentRequest;
}

function fakeIntentEditor(result: EditPlotIntentResult): {
	editor: PlotIntentEditor;
	calls: FakeIntentEditorCall[];
} {
	const calls: FakeIntentEditorCall[] = [];
	const editor: PlotIntentEditor = {
		async edit(input) {
			calls.push({ input });
			return result;
		},
	};
	return { editor, calls };
}

describe("POST /plots/:id/intent", () => {
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
		goal: "ship oauth",
		non_goals: ["yak shave"],
		constraints: ["no third-party"],
		success_criteria: ["green CI"],
	};

	const events: PlotEvent[] = [
		{
			type: "plot_created",
			actor: "user:alice",
			at: "2026-05-18T01:00:00Z",
			data: { name: "P" },
		},
		{
			type: "intent_edited",
			actor: "user:alice",
			at: "2026-05-18T01:30:00Z",
			data: { field: "goal", value: "ship oauth" },
		},
	];

	const RESULT: EditPlotIntentResult = {
		id: "pt-int",
		name: "P",
		status: "active",
		intent,
		attachments: [],
		event_log: events,
	};

	test("happy path: applies the patch and returns the full envelope", async () => {
		const project = await seedProject(repos, { id: "proj-int", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				goal: "ship oauth",
				non_goals: ["yak shave"],
				dispatcher_handle: "alice",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as PlotEnvelope;
		expect(body.id).toBe("pt-int");
		expect(body.intent).toEqual(intent);
		expect(body.event_log).toEqual(events);
		expect(body.project_id).toBe(project.id);

		expect(resolverCalls).toEqual(["pt-int"]);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one editor call");
		expect(call.input.plotId).toBe("pt-int");
		expect(call.input.handle).toBe("alice");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);
		expect(call.input.patch).toEqual({ goal: "ship oauth", non_goals: ["yak shave"] });

		// Aggregator cache invalidated so a follow-up list sees the new
		// intent_goal_preview without the 5s TTL.
		expect(state.invalidates).toEqual([project.id]);
	});

	test("empty body submits an empty no-op patch", async () => {
		const project = await seedProject(repos, { id: "proj-empty", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one editor call");
		expect(call.input.patch).toEqual({});
		expect(call.input.handle).toBe("operator");
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-handle", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x", dispatcher_handle: "!!nope!!" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one editor call");
		expect(call.input.handle).toBe("operator");
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({ repos, plotIntentEditor: editor });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-anything/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flipped", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flipped": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flipped/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("rejects unknown intent field with 400", async () => {
		const project = await seedProject(repos, { id: "proj-bad", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x", nongoals: ["typo"] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.message).toContain("nongoals");
		expect(calls).toEqual([]);
	});

	test("rejects non-string-array list field with 400", async () => {
		const project = await seedProject(repos, { id: "proj-arr", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ non_goals: "oops" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("surfaces PlotIntentFrozenError from the editor as 409", async () => {
		const project = await seedProject(repos, { id: "proj-frozen", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-done": project });
		const frozen: PlotIntentEditor = {
			async edit() {
				throw new PlotIntentFrozenError("plot pt-done is done; intent is frozen per SPEC §6");
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: frozen,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-done/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "too late" }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("plot_intent_frozen");
		expect(body.error.message).toContain("pt-done");
	});

	test("propagates generic editor errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const boom: PlotIntentEditor = {
			async edit() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: boom,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x" }),
		});
		expect(res.status).toBe(500);
	});
});

/* ----------------------------------------------------------------------- */
/* POST /plots/:id/status (warren-e868 / pl-9d6a step 10)                   */
/* ----------------------------------------------------------------------- */

interface FakeStatusChangerCall {
	readonly input: ChangePlotStatusRequest;
}

function fakeStatusChanger(result: ChangePlotStatusResult): {
	changer: PlotStatusChanger;
	calls: FakeStatusChangerCall[];
} {
	const calls: FakeStatusChangerCall[] = [];
	const changer: PlotStatusChanger = {
		async change(input) {
			calls.push({ input });
			return result;
		},
	};
	return { changer, calls };
}

function statusChangedResult(over: {
	id?: string;
	to: PlotStatus;
	from: PlotStatus;
	at?: string;
	actor?: string;
}): ChangePlotStatusResult {
	const at = over.at ?? "2026-05-18T02:00:00Z";
	const actor = over.actor ?? "user:alice";
	const event: PlotEvent = {
		type: "status_changed",
		actor,
		at,
		data: { from: over.from, to: over.to },
	};
	return {
		id: over.id ?? "pt-st",
		name: "S",
		status: over.to,
		intent_goal_preview: "",
		attachments_count: 0,
		last_event_ts: at,
		last_event_actor: actor,
		event,
	};
}

describe("POST /plots/:id/status", () => {
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

	test("happy path: returns the new summary + emitted status_changed event", async () => {
		const project = await seedProject(repos, { id: "proj-st", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-st": project });
		const result = statusChangedResult({ to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready", dispatcher_handle: "alice" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			summary: PlotSummary;
			event: PlotEvent;
		};
		expect(body.summary.id).toBe("pt-st");
		expect(body.summary.status).toBe("ready");
		expect(body.summary.project_id).toBe(project.id);
		expect(body.event.type).toBe("status_changed");
		expect((body.event.data as { to?: string }).to).toBe("ready");

		expect(resolverCalls).toEqual(["pt-st"]);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one changer call");
		expect(call.input.plotId).toBe("pt-st");
		expect(call.input.handle).toBe("alice");
		expect(call.input.next).toBe("ready");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);

		// Aggregator cache invalidated so a follow-up list sees the new
		// status without the 5s TTL.
		expect(state.invalidates).toEqual([project.id]);
	});

	test("transition matrix: legal transitions pass through to the changer", async () => {
		const project = await seedProject(repos, { id: "proj-mx", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-mx": project });
		const result = statusChangedResult({ id: "pt-mx", to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		// Every legal SPEC §6.5 next-status (the matrix pin lives in
		// status-changer.test.ts; this just confirms the wire shape lets
		// them all through).
		for (const next of ["drafting", "ready", "active", "done", "archived"] as const) {
			const res = await fetch(`${tcpUrl(handle)}/plots/pt-mx/status`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ next }),
			});
			expect(res.status).toBe(200);
		}
		expect(calls).toHaveLength(5);
	});

	test("rejects unknown `next` with 400 (typo guard at the handler edge)", async () => {
		const project = await seedProject(repos, { id: "proj-typo", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-st": project });
		const result = statusChangedResult({ to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "wat" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("wat");
		expect(calls).toEqual([]);
	});

	test("rejects missing `next` with 400", async () => {
		const project = await seedProject(repos, { id: "proj-miss", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-st": project });
		const result = statusChangedResult({ to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-h", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-st": project });
		const result = statusChangedResult({ to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready", dispatcher_handle: "!!nope!!" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one changer call");
		expect(call.input.handle).toBe("operator");
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { changer, calls } = fakeStatusChanger(
			statusChangedResult({ to: "ready", from: "drafting" }),
		);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { changer, calls } = fakeStatusChanger(
			statusChangedResult({ to: "ready", from: "drafting" }),
		);
		const deps = await depsFor({ repos, plotStatusChanger: changer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-x/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flip", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flip": project });
		const { changer, calls } = fakeStatusChanger(
			statusChangedResult({ to: "ready", from: "drafting" }),
		);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flip/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("surfaces PlotIllegalStatusTransitionError from the changer as 409", async () => {
		const project = await seedProject(repos, { id: "proj-il", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-il": project });
		const illegal: PlotStatusChanger = {
			async change() {
				throw new PlotIllegalStatusTransitionError(
					"plot pt-il cannot transition drafting → done per SPEC §6.5",
				);
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: illegal,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-il/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "done" }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("plot_illegal_status_transition");
		expect(body.error.message).toContain("pt-il");
	});

	test("propagates generic changer errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-st": project });
		const boom: PlotStatusChanger = {
			async change() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: boom,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready" }),
		});
		expect(res.status).toBe(500);
	});

	test("agent-actor unreachability: PlotStatusChanger.change input has no actor-kind field", () => {
		// Compile-time pin (mx-bd4d67): the wire request to the changer
		// carries only a string `handle` — there's no way for a caller
		// (or warren's own handler) to thread an agent actor through
		// this seam. The underlying UserPlotClient hard-codes
		// `kind: "user"`, so `setStatus` is unreachable from the agent
		// surface at the type level. Asserted here so a future refactor
		// that widens the seam to a typed actor accidentally breaks
		// this test.
		const probe: ChangePlotStatusRequest = {
			plotDir: "/x/.plot",
			plotId: "pt-x",
			handle: "alice",
			next: "ready",
		};
		// @ts-expect-error — `actor` is not a field on ChangePlotStatusRequest
		const _bad: ChangePlotStatusRequest = { ...probe, actor: { kind: "agent" } };
		void _bad;
		expect(Object.keys(probe)).toEqual(["plotDir", "plotId", "handle", "next"]);
	});
});

/* ----------------------------------------------------------------------- */
/* POST /plots/:id/attachments + DELETE /plots/:id/attachments/:ref         */
/* (warren-589c / pl-9d6a step 11)                                          */
/* ----------------------------------------------------------------------- */

interface FakeAttacherCall {
	readonly kind: "attach" | "detach";
	readonly attach?: AttachPlotRequest;
	readonly detach?: DetachPlotRequest;
}

function fakeAttacher(over: { attach?: AttachPlotResult; detach?: DetachPlotResult }): {
	attacher: PlotAttacher;
	calls: FakeAttacherCall[];
} {
	const calls: FakeAttacherCall[] = [];
	const attacher: PlotAttacher = {
		async attach(input) {
			calls.push({ kind: "attach", attach: input });
			if (over.attach === undefined) throw new Error("no attach result configured");
			return over.attach;
		},
		async detach(input) {
			calls.push({ kind: "detach", detach: input });
			if (over.detach === undefined) throw new Error("no detach result configured");
			return over.detach;
		},
	};
	return { attacher, calls };
}

const sampleIntent: Intent = {
	goal: "",
	non_goals: [],
	constraints: [],
	success_criteria: [],
};

function attachResult(over: Partial<AttachPlotResult>): AttachPlotResult {
	const attachment: Attachment = {
		id: "att-001",
		type: "seeds_issue",
		ref: "proj-abcd",
		role: "tracks",
		added_at: "2026-05-18T03:00:00Z",
		added_by: "user:alice",
		...(over.attachment ?? {}),
	};
	const ev: PlotEvent = {
		type: "attachment_added",
		actor: "user:alice",
		at: "2026-05-18T03:00:00Z",
		data: {
			id: attachment.id,
			type: attachment.type,
			ref: attachment.ref,
			role: attachment.role,
		},
	};
	return {
		id: over.id ?? "pt-at",
		name: over.name ?? "A",
		status: over.status ?? "active",
		intent: over.intent ?? sampleIntent,
		attachments: over.attachments ?? [attachment],
		event_log: over.event_log ?? [ev],
		attachment,
	};
}

function detachResult(over: Partial<DetachPlotResult>): DetachPlotResult {
	const ev: PlotEvent = {
		type: "attachment_removed",
		actor: "user:alice",
		at: "2026-05-18T03:30:00Z",
		data: { id: over.removed_id ?? "att-001" },
	};
	return {
		id: over.id ?? "pt-at",
		name: over.name ?? "A",
		status: over.status ?? "active",
		intent: over.intent ?? sampleIntent,
		attachments: over.attachments ?? [],
		event_log: over.event_log ?? [ev],
		removed_id: over.removed_id ?? "att-001",
	};
}

describe("POST /plots/:id/attachments", () => {
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

	test("happy path: attaches and returns the envelope + new attachment", async () => {
		const project = await seedProject(repos, { id: "proj-at", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotAttacher: attacher,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "seeds_issue",
				ref: "proj-abcd",
				role: "tracks",
				dispatcher_handle: "alice",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			envelope: PlotEnvelope;
			attachment: Attachment;
		};
		expect(body.envelope.id).toBe("pt-at");
		expect(body.envelope.project_id).toBe(project.id);
		expect(body.attachment.id).toBe("att-001");
		expect(body.attachment.ref).toBe("proj-abcd");

		expect(resolverCalls).toEqual(["pt-at"]);
		expect(calls).toHaveLength(1);
		const call = calls[0]?.attach;
		if (call === undefined) throw new Error("expected one attach call");
		expect(call.plotId).toBe("pt-at");
		expect(call.handle).toBe("alice");
		expect(call.kind).toBe("seeds_issue");
		expect(call.ref).toBe("proj-abcd");
		expect(call.role).toBe("tracks");
		expect(call.plotDir).toBe(`${project.localPath}/.plot`);

		expect(state.invalidates).toEqual([project.id]);
	});

	test("omits role when not supplied (attacher defaults it lib-side)", async () => {
		const project = await seedProject(repos, { id: "proj-at2", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotAttacher: attacher,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "mulch_record", ref: "mx-abc123" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0]?.attach;
		if (call === undefined) throw new Error("expected one attach call");
		expect(call.role).toBeUndefined();
		expect(call.handle).toBe("operator");
	});

	test("rejects unknown kind with 400", async () => {
		const project = await seedProject(repos, { id: "proj-bk", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "canopy_prompt", ref: "anything" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("canopy_prompt");
		expect(calls).toEqual([]);
	});

	test("rejects mis-shaped seeds_issue ref with 400 (handler-edge pattern guard)", async () => {
		const project = await seedProject(repos, { id: "proj-shape", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "seeds_issue", ref: "not-a-seed-id" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects empty ref with 400", async () => {
		const project = await seedProject(repos, { id: "proj-em", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects empty role with 400 when role is present", async () => {
		const project = await seedProject(repos, { id: "proj-er", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1", role: "" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-x/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flip", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flip": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flip/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-h", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "gh_pr",
				ref: "owner/repo#1",
				dispatcher_handle: "!!nope!!",
			}),
		});
		expect(res.status).toBe(200);
		const call = calls[0]?.attach;
		if (call === undefined) throw new Error("expected one attach call");
		expect(call.handle).toBe("operator");
	});

	test("propagates generic attacher errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const boom: PlotAttacher = {
			async attach() {
				throw new Error("disk on fire");
			},
			async detach() {
				throw new Error("unused");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1" }),
		});
		expect(res.status).toBe(500);
	});
});

describe("DELETE /plots/:id/attachments/:ref", () => {
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

	test("happy path: detaches and returns the envelope + removed_id", async () => {
		const project = await seedProject(repos, { id: "proj-de", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-de": project });
		const { attacher, calls } = fakeAttacher({
			detach: detachResult({ id: "pt-de", removed_id: "att-007" }),
		});
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotAttacher: attacher,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-de/attachments/${encodeURIComponent("proj-abcd")}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { envelope: PlotEnvelope; removed_id: string };
		expect(body.envelope.id).toBe("pt-de");
		expect(body.envelope.project_id).toBe(project.id);
		expect(body.removed_id).toBe("att-007");

		expect(resolverCalls).toEqual(["pt-de"]);
		expect(calls).toHaveLength(1);
		const call = calls[0]?.detach;
		if (call === undefined) throw new Error("expected one detach call");
		expect(call.plotId).toBe("pt-de");
		expect(call.ref).toBe("proj-abcd");
		expect(call.handle).toBe("operator");
		expect(call.plotDir).toBe(`${project.localPath}/.plot`);

		expect(state.invalidates).toEqual([project.id]);
	});

	test("decodes URL-encoded refs (slashes, hashes)", async () => {
		const project = await seedProject(repos, { id: "proj-enc", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const ref = "owner/repo#42";
		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-de/attachments/${encodeURIComponent(ref)}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		const call = calls[0]?.detach;
		if (call === undefined) throw new Error("expected one detach call");
		expect(call.ref).toBe(ref);
	});

	test("threads body-supplied dispatcher_handle through", async () => {
		const project = await seedProject(repos, { id: "proj-hd", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-de/attachments/proj-abcd`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dispatcher_handle: "alice" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0]?.detach;
		if (call === undefined) throw new Error("expected one detach call");
		expect(call.handle).toBe("alice");
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-h2", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-de/attachments/proj-abcd`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dispatcher_handle: "!!nope!!" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0]?.detach;
		if (call === undefined) throw new Error("expected one detach call");
		expect(call.handle).toBe("operator");
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/attachments/proj-abcd`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-x/attachments/proj-abcd`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flip", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flip": project });
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flip/attachments/proj-abcd`, {
			method: "DELETE",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("surfaces PlotAttachmentNotFoundError from the attacher as 404", async () => {
		const project = await seedProject(repos, { id: "proj-nf", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const missing: PlotAttacher = {
			async attach() {
				throw new Error("unused");
			},
			async detach() {
				throw new PlotAttachmentNotFoundError("plot pt-de has no attachment with ref 'nope'");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: missing });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-de/attachments/nope`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("plot_attachment_not_found");
		expect(body.error.message).toContain("nope");
	});

	test("propagates generic attacher errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const boom: PlotAttacher = {
			async attach() {
				throw new Error("unused");
			},
			async detach() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-de/attachments/proj-abcd`, {
			method: "DELETE",
		});
		expect(res.status).toBe(500);
	});

	test("agent-actor unreachability: attacher request types have no actor-kind field", () => {
		// Compile-time pin (mx-bd4d67): the wire requests to the
		// attacher carry only a string `handle` — there's no way for a
		// caller (or warren's own handler) to thread an agent actor
		// through this seam. The underlying UserPlotClient hard-codes
		// `kind: "user"`.
		const a: AttachPlotRequest = {
			plotDir: "/x/.plot",
			plotId: "pt-x",
			handle: "alice",
			kind: "seeds_issue",
			ref: "proj-abcd",
		};
		const d: DetachPlotRequest = {
			plotDir: "/x/.plot",
			plotId: "pt-x",
			handle: "alice",
			ref: "proj-abcd",
		};
		// @ts-expect-error — `actor` is not a field on AttachPlotRequest
		const _badA: AttachPlotRequest = { ...a, actor: { kind: "agent" } };
		// @ts-expect-error — `actor` is not a field on DetachPlotRequest
		const _badD: DetachPlotRequest = { ...d, actor: { kind: "agent" } };
		void _badA;
		void _badD;
		expect(Object.keys(a).sort()).toEqual(["handle", "kind", "plotDir", "plotId", "ref"]);
		expect(Object.keys(d).sort()).toEqual(["handle", "plotDir", "plotId", "ref"]);
	});
});

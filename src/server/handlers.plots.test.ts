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
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { PlotAggregator, PlotSummary } from "../plots/index.ts";
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
	};
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

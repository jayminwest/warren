import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { PlotAggregator, PlotSummary } from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, summary, tcpUrl } from "./plots.test-support.ts";

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

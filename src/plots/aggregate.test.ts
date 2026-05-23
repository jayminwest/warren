/**
 * Unit tests for the Plot aggregator (warren-7e85 / pl-9d6a step 1).
 *
 * Pins:
 *   - the byte-identical-empty-array contract when zero projects have
 *     `hasPlot=true`,
 *   - the per-project rebuild-on-failure retry (mx-239786 pattern),
 *   - the 5s in-memory cache keyed by `project_id`,
 *   - the parallel-across-projects fan-out (no serial dependency),
 *   - `last_event_ts desc` ordering with `id` as the stable tiebreak,
 *   - per-project failure isolation (one broken `.plot/` ⇒ empty for
 *     that project, not a 500 for the deployment).
 *
 * The live `UserPlotClient` round-trip is exercised by scenario 28
 * (warren-5b8a). Here we stub at `AggregatorPlotClient`.
 */

import { describe, expect, test } from "bun:test";
import type { PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import type { ProjectRow, RunRow } from "../db/schema.ts";
import type { Logger } from "../server/types.ts";
import {
	type AggregatorClientFactory,
	type AggregatorPlotClient,
	type AggregatorRunsRepo,
	createPlotAggregator,
	EMPTY_PLOT_SUMMARIES,
} from "./aggregate.ts";

function silentLogger(): Logger {
	return {
		info() {},
		warn() {},
		error() {},
	};
}

function captureLogger(): { logger: Logger; warns: Array<{ obj: object; msg?: string }> } {
	const warns: Array<{ obj: object; msg?: string }> = [];
	return {
		warns,
		logger: {
			info() {},
			warn(obj, msg) {
				warns.push({ obj, msg });
			},
			error() {},
		},
	};
}

function project(id: string, hasPlot = true): ProjectRow {
	return {
		id,
		gitUrl: `https://example.com/${id}.git`,
		localPath: `/tmp/${id}`,
		defaultBranch: "main",
		addedAt: "2026-01-01T00:00:00Z",
		lastFetchedAt: null,
		lastHeadSha: null,
		hasPlot,
		hasSeeds: false,
	};
}

interface StubPlot {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly updated_at: string;
	readonly goal: string;
	readonly attachments: number;
	readonly events: ReadonlyArray<PlotEvent>;
}

interface StubBehaviour {
	readonly plots: ReadonlyArray<StubPlot>;
	readonly failFirstQuery?: boolean;
	readonly failAllQueries?: boolean;
	/**
	 * Plots that exist on disk as `*.json` files but are missing from
	 * the index DB. When set, `query()` returns rows derived from
	 * `plots` (typically empty until `rebuildIndex` runs), and
	 * `rebuildIndex` migrates these into `plots` so the retry sees
	 * them. Models the warren-ede7 cold-cache empty-rows path.
	 */
	readonly plotsOnDiskOnly?: ReadonlyArray<StubPlot>;
	/**
	 * Override the disk probe result. When `plotsOnDiskOnly` is set
	 * this defaults to `true`; otherwise to `plots.length > 0`.
	 */
	readonly hasFilesOnDisk?: boolean;
}

interface StubMetrics {
	queryCalls: number;
	rebuildCalls: number;
	closeCalls: number;
	hasFilesOnDiskCalls: number;
}

function makeFactory(perProject: Record<string, StubBehaviour>): {
	factory: AggregatorClientFactory;
	metrics: Record<string, StubMetrics>;
} {
	const metrics: Record<string, StubMetrics> = {};
	const factory: AggregatorClientFactory = (p) => {
		const behaviour = perProject[p.id];
		if (behaviour === undefined) {
			throw new Error(`unexpected project in factory: ${p.id}`);
		}
		let m = metrics[p.id];
		if (m === undefined) {
			m = { queryCalls: 0, rebuildCalls: 0, closeCalls: 0, hasFilesOnDiskCalls: 0 };
			metrics[p.id] = m;
		}
		// Live view of indexed plots — rebuildIndex absorbs the
		// `plotsOnDiskOnly` set so the retry query sees them.
		const indexed: StubPlot[] = [...behaviour.plots];
		const onDiskOnly: StubPlot[] = behaviour.plotsOnDiskOnly ? [...behaviour.plotsOnDiskOnly] : [];
		const client: AggregatorPlotClient = {
			async query() {
				m.queryCalls += 1;
				if (behaviour.failAllQueries) throw new Error("query-broken");
				if (behaviour.failFirstQuery && m.queryCalls === 1) {
					throw new Error("first-query-broken");
				}
				return { rows: indexed.map((pl) => ({ id: pl.id })) };
			},
			async rebuildIndex() {
				m.rebuildCalls += 1;
				while (onDiskOnly.length > 0) {
					const next = onDiskOnly.shift();
					if (next !== undefined) indexed.push(next);
				}
			},
			async hasPlotFilesOnDisk() {
				m.hasFilesOnDiskCalls += 1;
				if (behaviour.hasFilesOnDisk !== undefined) return behaviour.hasFilesOnDisk;
				if (onDiskOnly.length > 0 || indexed.length > 0) return true;
				return false;
			},
			async readPlot(plotId) {
				const pl = indexed.find((x) => x.id === plotId);
				if (pl === undefined) throw new Error(`unknown plot ${plotId}`);
				return {
					name: pl.name,
					status: pl.status,
					updated_at: pl.updated_at,
					intent: { goal: pl.goal },
					attachments: new Array(pl.attachments).fill(null),
				};
			},
			async readEvents(plotId) {
				const pl = indexed.find((x) => x.id === plotId);
				if (pl === undefined) throw new Error(`unknown plot ${plotId}`);
				return pl.events;
			},
			close() {
				m.closeCalls += 1;
			},
		};
		return client;
	};
	return { factory, metrics };
}

function noteEvent(at: string, actor: string): PlotEvent {
	return {
		type: "note",
		actor,
		at,
		data: { text: "x" },
	};
}

describe("createPlotAggregator", () => {
	test("returns the canonical EMPTY reference when no project has hasPlot=true", async () => {
		const projects = [project("prj_a", false), project("prj_b", false)];
		const { factory, metrics } = makeFactory({});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const r1 = await agg.listSummaries();
		const r2 = await agg.listSummaries({ status: "active" });
		// Byte-identical contract: same reference every call.
		expect(r1).toBe(EMPTY_PLOT_SUMMARIES);
		expect(r2).toBe(EMPTY_PLOT_SUMMARIES);
		expect(r1).toEqual([]);
		// Factory must NOT be opened when there are no Plot-enabled projects.
		expect(Object.keys(metrics)).toEqual([]);
	});

	test("returns EMPTY when there are no projects at all", async () => {
		const { factory } = makeFactory({});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => [] },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const r = await agg.listSummaries();
		expect(r).toBe(EMPTY_PLOT_SUMMARIES);
	});

	test("aggregates across hasPlot projects, sorts by last_event_ts desc, picks tail-event actor", async () => {
		const projects = [project("prj_a"), project("prj_b"), project("prj_c", false)];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-aaaa1111",
						name: "alpha",
						status: "active",
						updated_at: "2026-05-10T00:00:00Z",
						goal: "first plot goal",
						attachments: 2,
						events: [
							noteEvent("2026-05-10T00:00:00Z", "user:alice"),
							noteEvent("2026-05-12T00:00:00Z", "agent:claude-code:run_x"),
						],
					},
				],
			},
			prj_b: {
				plots: [
					{
						id: "plot-bbbb2222",
						name: "beta",
						status: "ready",
						updated_at: "2026-05-11T00:00:00Z",
						goal: "second goal",
						attachments: 0,
						events: [noteEvent("2026-05-11T00:00:00Z", "user:bob")],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const rows = await agg.listSummaries();
		expect(rows.map((r) => r.id)).toEqual(["plot-aaaa1111", "plot-bbbb2222"]);
		expect(rows[0]).toEqual({
			id: "plot-aaaa1111",
			name: "alpha",
			status: "active",
			intent_goal_preview: "first plot goal",
			attachments_count: 2,
			last_event_ts: "2026-05-12T00:00:00Z",
			last_event_actor: "agent:claude-code:run_x",
			project_id: "prj_a",
		});
		expect(rows[1]?.project_id).toBe("prj_b");
		expect(rows[1]?.last_event_actor).toBe("user:bob");
	});

	test("applies the status filter post-aggregation", async () => {
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-active",
						name: "a",
						status: "active",
						updated_at: "2026-05-01T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-01T00:00:00Z", "user:a")],
					},
					{
						id: "plot-archived",
						name: "z",
						status: "archived",
						updated_at: "2026-05-02T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-02T00:00:00Z", "user:a")],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const filtered = await agg.listSummaries({ status: "active" });
		expect(filtered.map((r) => r.id)).toEqual(["plot-active"]);
		const all = await agg.listSummaries();
		expect(all.map((r) => r.id).sort()).toEqual(["plot-active", "plot-archived"]);
	});

	test("retries the index query once after rebuildIndex on first-attempt failure", async () => {
		const projects = [project("prj_a")];
		const { factory, metrics } = makeFactory({
			prj_a: {
				failFirstQuery: true,
				plots: [
					{
						id: "plot-r",
						name: "r",
						status: "ready",
						updated_at: "2026-05-01T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-01T00:00:00Z", "user:a")],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const rows = await agg.listSummaries();
		expect(rows.map((r) => r.id)).toEqual(["plot-r"]);
		expect(metrics.prj_a?.queryCalls).toBe(2);
		expect(metrics.prj_a?.rebuildCalls).toBe(1);
		expect(metrics.prj_a?.closeCalls).toBe(1);
	});

	test("rebuilds the index when the first query returns empty rows but .plot/ has *.json files on disk (warren-ede7)", async () => {
		const projects = [project("prj_a")];
		const { factory, metrics } = makeFactory({
			prj_a: {
				plots: [],
				plotsOnDiskOnly: [
					{
						id: "plot-3e72876d",
						name: "housekeeping",
						status: "active",
						updated_at: "2026-05-18T00:00:00Z",
						goal: "housekeeping pass",
						attachments: 0,
						events: [noteEvent("2026-05-18T00:00:00Z", "user:operator")],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const rows = await agg.listSummaries();
		expect(rows.map((r) => r.id)).toEqual(["plot-3e72876d"]);
		expect(metrics.prj_a?.queryCalls).toBe(2);
		expect(metrics.prj_a?.rebuildCalls).toBe(1);
		expect(metrics.prj_a?.hasFilesOnDiskCalls).toBe(1);
	});

	test("does NOT rebuild when the first query returns empty rows and .plot/ has zero *.json files (warren-ede7)", async () => {
		const projects = [project("prj_a")];
		const { factory, metrics } = makeFactory({
			prj_a: {
				plots: [],
				hasFilesOnDisk: false,
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const rows = await agg.listSummaries();
		expect(rows).toEqual([]);
		expect(metrics.prj_a?.queryCalls).toBe(1);
		expect(metrics.prj_a?.rebuildCalls).toBe(0);
		expect(metrics.prj_a?.hasFilesOnDiskCalls).toBe(1);
	});

	test("isolates per-project failures: a broken .plot/ does not 500 the deployment", async () => {
		const projects = [project("prj_a"), project("prj_b")];
		const { factory } = makeFactory({
			prj_a: { failAllQueries: true, plots: [] },
			prj_b: {
				plots: [
					{
						id: "plot-ok",
						name: "ok",
						status: "active",
						updated_at: "2026-05-01T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-01T00:00:00Z", "user:b")],
					},
				],
			},
		});
		const cap = captureLogger();
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: cap.logger,
			clientFactory: factory,
		});
		const rows = await agg.listSummaries();
		expect(rows.map((r) => r.id)).toEqual(["plot-ok"]);
		expect(cap.warns.some((w) => w.msg === "plots.aggregate_project_failed")).toBe(true);
	});

	test("caches per-project results within the TTL window and invalidate() clears them", async () => {
		const projects = [project("prj_a")];
		const { factory, metrics } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-c",
						name: "c",
						status: "ready",
						updated_at: "2026-05-01T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-01T00:00:00Z", "user:a")],
					},
				],
			},
		});
		let clock = 1_000;
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
			cacheTtlMs: 5_000,
			now: () => clock,
		});
		await agg.listSummaries();
		await agg.listSummaries();
		expect(metrics.prj_a?.queryCalls).toBe(1);
		// Advance past TTL.
		clock += 6_000;
		await agg.listSummaries();
		expect(metrics.prj_a?.queryCalls).toBe(2);
		// Invalidate forces a re-fetch even within TTL.
		agg.invalidate("prj_a");
		await agg.listSummaries();
		expect(metrics.prj_a?.queryCalls).toBe(3);
		// invalidate() with no arg drops everything.
		agg.invalidate();
		await agg.listSummaries();
		expect(metrics.prj_a?.queryCalls).toBe(4);
	});

	test("intent_goal_preview truncates long goals to ≤160 chars with ellipsis", async () => {
		const longGoal = "x".repeat(400);
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-long",
						name: "long",
						status: "drafting",
						updated_at: "2026-05-01T00:00:00Z",
						goal: longGoal,
						attachments: 0,
						events: [noteEvent("2026-05-01T00:00:00Z", "user:a")],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const rows = await agg.listSummaries();
		const preview = rows[0]?.intent_goal_preview ?? "";
		expect(preview.length).toBe(160);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("falls back to plot.updated_at + empty actor when the event log is empty", async () => {
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-e",
						name: "e",
						status: "drafting",
						updated_at: "2026-05-01T12:00:00Z",
						goal: "",
						attachments: 0,
						events: [],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
		});
		const rows = await agg.listSummaries();
		expect(rows[0]?.last_event_ts).toBe("2026-05-01T12:00:00Z");
		expect(rows[0]?.last_event_actor).toBe("");
		expect(rows[0]?.intent_goal_preview).toBe("");
	});
});

/**
 * Needs-attention scorer integration (warren-d693 / pl-0344 step 9).
 * The pure per-Plot policy lives in `./needs-attention.ts` and has its
 * own unit tests there; here we pin the aggregator-level wiring: paused
 * runs grouped from `listByState('paused')`, stale-draft window applied
 * with the injected clock, and the count endpoint mirroring the list.
 */
function pausedRunsRepo(plotIds: readonly (string | null)[]): AggregatorRunsRepo {
	return {
		async listByState(state) {
			expect(state).toBe("paused");
			return plotIds.map((id) => ({ plotId: id }) as unknown as RunRow);
		},
	};
}

describe("createPlotAggregator listNeedsAttention", () => {
	test("flags Plots with a paused run on the runsRepo", async () => {
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-paused1",
						name: "p",
						status: "active",
						updated_at: "2026-05-20T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-20T00:00:00Z", "user:a")],
					},
					{
						id: "plot-quiet1",
						name: "q",
						status: "active",
						updated_at: "2026-05-20T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-20T00:00:00Z", "user:a")],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
			runsRepo: pausedRunsRepo(["plot-paused1", null]),
			now: () => Date.parse("2026-05-21T00:00:00Z"),
		});
		const rows = await agg.listNeedsAttention();
		expect(rows.map((r) => r.id)).toEqual(["plot-paused1"]);
		expect(rows[0]?.reasons).toEqual(["paused_run"]);
		expect(await agg.countNeedsAttention()).toBe(1);
	});

	test("flags drafting Plots whose last_event_ts is older than the stale window", async () => {
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-stale1",
						name: "old draft",
						status: "drafting",
						updated_at: "2026-05-01T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-01T00:00:00Z", "user:a")],
					},
					{
						id: "plot-fresh1",
						name: "fresh draft",
						status: "drafting",
						updated_at: "2026-05-20T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-20T00:00:00Z", "user:a")],
					},
					{
						id: "plot-doneish",
						name: "non-draft",
						status: "active",
						updated_at: "2026-04-01T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-04-01T00:00:00Z", "user:a")],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
			runsRepo: pausedRunsRepo([]),
			staleDraftAfterDays: 7,
			// 21 days after plot-stale1's last event, 1 day after plot-fresh1's.
			now: () => Date.parse("2026-05-21T00:00:00Z"),
		});
		const rows = await agg.listNeedsAttention();
		expect(rows.map((r) => r.id)).toEqual(["plot-stale1"]);
		expect(rows[0]?.reasons).toEqual(["stale_draft"]);
	});

	test("flags merged gh_pr attachments with no follow-up review event", async () => {
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-pr1",
						name: "merged pr unreviewed",
						status: "active",
						updated_at: "2026-05-20T00:00:00Z",
						goal: "g",
						attachments: 1,
						events: [
							{
								type: "artifact_produced",
								actor: "agent:claude-code:run_x",
								at: "2026-05-20T00:00:00Z",
								data: { type: "gh_pr", ref: "owner/repo#42" },
							} as PlotEvent,
						],
					},
					{
						id: "plot-pr2",
						name: "merged pr reviewed",
						status: "active",
						updated_at: "2026-05-20T00:00:00Z",
						goal: "g",
						attachments: 1,
						events: [
							{
								type: "artifact_produced",
								actor: "agent:x",
								at: "2026-05-20T00:00:00Z",
								data: { type: "gh_pr", ref: "owner/repo#43" },
							} as PlotEvent,
							{
								type: "decision_made",
								actor: "user:operator",
								at: "2026-05-21T00:00:00Z",
								data: { summary: "reviewed owner/repo#43, looks good" },
							} as PlotEvent,
						],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
			runsRepo: pausedRunsRepo([]),
			now: () => Date.parse("2026-05-22T00:00:00Z"),
		});
		const rows = await agg.listNeedsAttention();
		expect(rows.map((r) => r.id)).toEqual(["plot-pr1"]);
		expect(rows[0]?.reasons).toEqual(["merged_pr_unreviewed"]);
	});

	test("returns multiple reasons in canonical order for a single Plot", async () => {
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-multi",
						name: "multi-signal",
						status: "drafting",
						updated_at: "2026-05-01T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [
							noteEvent("2026-05-01T00:00:00Z", "user:a"),
							{
								type: "artifact_produced",
								actor: "agent:x",
								at: "2026-05-01T01:00:00Z",
								data: { type: "gh_pr", ref: "owner/repo#1" },
							} as PlotEvent,
						],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
			runsRepo: pausedRunsRepo(["plot-multi"]),
			staleDraftAfterDays: 7,
			now: () => Date.parse("2026-05-21T00:00:00Z"),
		});
		const rows = await agg.listNeedsAttention();
		expect(rows[0]?.reasons).toEqual(["paused_run", "merged_pr_unreviewed", "stale_draft"]);
	});

	test("returns [] when no Plot qualifies and countNeedsAttention agrees", async () => {
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-ok",
						name: "ok",
						status: "active",
						updated_at: "2026-05-20T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-20T00:00:00Z", "user:a")],
					},
				],
			},
		});
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: silentLogger(),
			clientFactory: factory,
			runsRepo: pausedRunsRepo([]),
			now: () => Date.parse("2026-05-21T00:00:00Z"),
		});
		expect(await agg.listNeedsAttention()).toEqual([]);
		expect(await agg.countNeedsAttention()).toBe(0);
	});

	test("tolerates a runsRepo query failure (logs + treats as zero paused runs)", async () => {
		const projects = [project("prj_a")];
		const { factory } = makeFactory({
			prj_a: {
				plots: [
					{
						id: "plot-x",
						name: "x",
						status: "active",
						updated_at: "2026-05-20T00:00:00Z",
						goal: "g",
						attachments: 0,
						events: [noteEvent("2026-05-20T00:00:00Z", "user:a")],
					},
				],
			},
		});
		const cap = captureLogger();
		const agg = createPlotAggregator({
			projectsRepo: { listAll: async () => projects },
			logger: cap.logger,
			clientFactory: factory,
			runsRepo: {
				async listByState() {
					throw new Error("runs db down");
				},
			},
			now: () => Date.parse("2026-05-21T00:00:00Z"),
		});
		expect(await agg.listNeedsAttention()).toEqual([]);
		expect(cap.warns.some((w) => w.msg === "plots.needs_attention_paused_query_failed")).toBe(true);
	});
});

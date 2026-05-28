/**
 * Needs-attention scorer integration (warren-d693 / pl-0344 step 9).
 * The pure per-Plot policy lives in `./needs-attention.ts` and has its
 * own unit tests there; here we pin the aggregator-level wiring: paused
 * runs grouped from `listByState('paused')`, stale-draft window applied
 * with the injected clock, and the count endpoint mirroring the list.
 */

import { describe, expect, test } from "bun:test";
import type { PlotEvent } from "@os-eco/plot-cli";
import {
	captureLogger,
	makeFactory,
	noteEvent,
	pausedRunsRepo,
	project,
	silentLogger,
} from "./aggregate.test-helpers.ts";
import { createPlotAggregator } from "./aggregate.ts";

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

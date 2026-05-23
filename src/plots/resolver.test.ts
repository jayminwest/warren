/**
 * Unit tests for `PlotResolver` (warren-7e85 / pl-9d6a step 1).
 *
 * The resolver is a thin layer over `PlotAggregator.listSummaries` —
 * tests pin the contract that:
 *   - the owning ProjectRow is returned for a known plot id,
 *   - `null` falls out for an unknown id (so handlers can map to 404),
 *   - the empty-string id short-circuits without touching the
 *     aggregator (defensive against bad URL params).
 */

import { describe, expect, test } from "bun:test";
import type { ProjectRow } from "../db/schema.ts";
import type { PlotAggregator } from "./aggregate.ts";
import { createPlotResolver } from "./resolver.ts";
import type { PlotSummary } from "./types.ts";

function project(id: string): ProjectRow {
	return {
		id,
		gitUrl: `https://example.com/${id}.git`,
		localPath: `/tmp/${id}`,
		defaultBranch: "main",
		addedAt: "2026-01-01T00:00:00Z",
		lastFetchedAt: null,
		lastHeadSha: null,
		hasPlot: true,
		hasSeeds: false,
	};
}

function summary(id: string, projectId: string): PlotSummary {
	return {
		id,
		name: id,
		status: "active",
		intent_goal_preview: "",
		attachments_count: 0,
		last_event_ts: "2026-05-01T00:00:00Z",
		last_event_actor: "user:a",
		project_id: projectId,
	};
}

function aggregatorReturning(rows: PlotSummary[]): {
	aggregator: PlotAggregator;
	listCalls: number;
} {
	let listCalls = 0;
	return {
		get listCalls() {
			return listCalls;
		},
		aggregator: {
			async listSummaries() {
				listCalls += 1;
				return rows;
			},
			async listNeedsAttention() {
				return [];
			},
			async countNeedsAttention() {
				return 0;
			},
			invalidate() {},
		},
	};
}

describe("createPlotResolver", () => {
	test("resolves the owning project for a known plot id", async () => {
		const projects = [project("prj_a"), project("prj_b")];
		const r = aggregatorReturning([
			summary("plot-aaaa1111", "prj_a"),
			summary("plot-bbbb2222", "prj_b"),
		]);
		const resolver = createPlotResolver({
			projectsRepo: { listAll: async () => projects },
			aggregator: r.aggregator,
		});
		const found = await resolver.resolve("plot-bbbb2222");
		expect(found?.id).toBe("prj_b");
	});

	test("returns null for an unknown plot id", async () => {
		const r = aggregatorReturning([summary("plot-known", "prj_a")]);
		const resolver = createPlotResolver({
			projectsRepo: { listAll: async () => [project("prj_a")] },
			aggregator: r.aggregator,
		});
		const found = await resolver.resolve("plot-missing");
		expect(found).toBeNull();
	});

	test("returns null on empty-string id without consulting the aggregator", async () => {
		const r = aggregatorReturning([summary("plot-known", "prj_a")]);
		const resolver = createPlotResolver({
			projectsRepo: { listAll: async () => [project("prj_a")] },
			aggregator: r.aggregator,
		});
		const found = await resolver.resolve("");
		expect(found).toBeNull();
		expect(r.listCalls).toBe(0);
	});

	test("returns null when the owning project_id is no longer in projectsRepo", async () => {
		// Defensive case: aggregator's cache predates a project delete.
		const r = aggregatorReturning([summary("plot-x", "prj_gone")]);
		const resolver = createPlotResolver({
			projectsRepo: { listAll: async () => [project("prj_a")] },
			aggregator: r.aggregator,
		});
		const found = await resolver.resolve("plot-x");
		expect(found).toBeNull();
	});
});

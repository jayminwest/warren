/**
 * Behavior analytics handler (warren-5d50 / pl-ad0f step 9), split out of
 * `./analytics.ts` under the file-size budget once the per-directory
 * difficulty (warren-8f1b) and outcome-joined (warren-be04) layers pushed
 * that module over 500 lines.
 */

import {
	buildCommandMining,
	buildContextWaste,
	buildDirectoryDifficulty,
	buildInsights,
	buildRunOutcomes,
	buildSteeringSignals,
	countSteeringByRun,
	type DirectoryDifficulty,
	runtimeFromRenderedAgent,
} from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	loadRunMetrics,
	loadToolCallRows,
	parseAnalyticsWindow,
	toMetricsRows,
} from "./analytics.ts";

/**
 * `GET /analytics/behavior?from=&to=&projectId=` (warren-5d50 / pl-ad0f step 9).
 *
 * The heavier companion to `GET /analytics/runs`. Resolves the same window,
 * loads the run-level rollup, then reads the structured `tool_calls` rollup
 * for those runs (`ToolCallsRepo.listForRuns`, warren-7746) and mines it for
 * the generalized command-frequency / failure / stuck-loop rankings
 * (`buildCommandMining`). A capped rollup read is reported as top-level
 * `truncated: true` — never the silent truncation the retired event scan had. Finally distills the metrics + mining into the
 * ranked, severity-coded callout list (`buildInsights`). The run-level rollup
 * itself stays on `/analytics/runs` — this endpoint returns just the behavior
 * layers (`mining` + `insights`) so the fast view can render independently.
 *
 * Steering event kinds scanned when building {@link SteeringSignals}
 * for `buildInsights`. The `steer.sent` kind is lightweight (at most a
 * handful per run) so it is fetched in a separate, uncapped query rather
 * than being mixed into the tool-event cap that bounds command mining.
 */
export function listBehaviorAnalyticsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const { echo, filter } = parseAnalyticsWindow(ctx);
		const { rows, metrics } = await loadRunMetrics(deps, filter);
		const runIds = rows.map((r) => r.id);
		const runtimeByRunId = new Map(
			rows.map((r) => [r.id, runtimeFromRenderedAgent(r.renderedAgentJson)]),
		);
		const [toolCalls, steeringRows] = await Promise.all([
			loadToolCallRows(deps, runIds, runtimeByRunId),
			deps.repos.events.listSteeringEventsForRuns(runIds),
		]);
		const mining = buildCommandMining(toolCalls.rows);
		const steering = buildSteeringSignals(steeringRows, rows.length);
		// warren-8f1b: the per-directory difficulty map. Joins the rollup's
		// fileShape-extracted paths to run outcomes, path-level retry
		// clusters, and per-run steering counts. Every bucket carries its
		// denominators + a confidence qualifier; runs predating the rollup
		// are unknown and excluded from denominators. Classification: this
		// route is `readOperator`, so directory names (repo layout) never
		// reach a `readPublic` spectator — if the policy ever relaxes, a
		// projection allowlist for `directories` must land first.
		const directories: DirectoryDifficulty = buildDirectoryDifficulty(
			toolCalls.directoryRows,
			rows.map((r) => ({ runId: r.id, state: r.state })),
			countSteeringByRun(steeringRows),
		);
		// warren-be04: the same trace feeds the outcome-joined rollup, which
		// both ships structured and drives the two outcome insight kinds.
		const metricsRows = toMetricsRows(rows);
		const outcomes = buildRunOutcomes(metricsRows, steeringRows, metrics);
		// warren-6d41: tool_result byte shares against run context tokens
		// from the same rollup rows — the context-waste proxy section plus
		// its insight kind. Pre-rollup runs are unknown, never zero.
		const contextWaste = buildContextWaste(toolCalls.rows, metricsRows);
		const insights = buildInsights({
			metrics,
			mining,
			steering,
			outcomes,
			directories,
			contextWaste,
		});
		// warren-7746: `truncated` reports the rollup read hitting its row
		// cap — the retired event scan truncated silently at 20k rows.
		return jsonResponse(200, {
			filter: echo,
			mining,
			directories,
			insights,
			outcomes,
			contextWaste,
			truncated: toolCalls.truncated,
		});
	};
}

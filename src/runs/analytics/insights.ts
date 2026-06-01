/**
 * Derived insights aggregator (warren-1788 / pl-ad0f step 8).
 *
 * Pure, dialect-agnostic capstone over the other two analytics aggregators.
 * Where `run-metrics.ts` and `command-mining.ts` emit exhaustive breakdowns,
 * this module distills them into a short, ranked list of human-readable
 * callouts — the "what should an operator look at first" layer the
 * `GET /analytics/behavior` endpoint (step 9) returns and the Phase-2 UI
 * (step 10) renders as severity-coded cards above the dense tables.
 *
 * It takes the already-computed {@link RunMetrics} + {@link CommandMining}
 * rollups (plus an optional {@link SteeringSignals} bundle the handler counts
 * while scanning events) and derives at most one {@link Insight} per category:
 *
 *   - `highest-context-seed`: the seed burning the most context tokens
 *   - `worst-success-agent`: the agent with the lowest success rate (only when
 *     it dips below a healthy threshold over a meaningful sample)
 *   - `most-failed-command`: the command that failed the most outright
 *   - `most-retried-command`: the strongest "stuck in a loop" signal
 *     (re-running a command that already failed in the same run)
 *   - `model-cost-outlier`: a model whose average per-run cost is a multiple of
 *     its peers' median
 *   - `steering-anomaly`: a high share of runs needing mid-run human steering
 *   - `pause-anomaly`: runs that stalled until their pause timed out
 *
 * Every callout carries a typed `kind`, a `severity`, a numeric `value` (the
 * metric that triggered it) and a `subject` (the seed / agent / command /
 * model it's about, or null). Insights with no signal are simply omitted —
 * a clean instance yields an empty list rather than a wall of "all good"
 * cards.
 *
 * Determinism: the list is sorted by severity (critical → warning → info),
 * then by a fixed per-kind order, so golden/unit tests are stable regardless
 * of which categories fired.
 */

import type { CommandMining, CommandStat } from "./command-mining.ts";
import type { RunGroupBucket, RunMetrics } from "./run-metrics.ts";

export type InsightSeverity = "info" | "warning" | "critical";

export type InsightKind =
	| "highest-context-seed"
	| "worst-success-agent"
	| "most-failed-command"
	| "most-retried-command"
	| "model-cost-outlier"
	| "steering-anomaly"
	| "pause-anomaly";

export interface Insight {
	readonly kind: InsightKind;
	readonly severity: InsightSeverity;
	/** short headline for the callout card. */
	readonly title: string;
	/** one-line explanation with the concrete numbers. */
	readonly detail: string;
	/** the metric value that triggered the callout (tokens, rate, count, usd). */
	readonly value: number;
	/** the subject (seedId / agent / command / model), or null when global. */
	readonly subject: string | null;
}

/**
 * Steering / pause counters the handler tallies while scanning events. All
 * optional — when omitted (or zeroed) the steering/pause insights are skipped.
 */
export interface SteeringSignals {
	readonly totalRuns: number;
	/** runs that received at least one mid-run steering message. */
	readonly runsSteered: number;
	/** total steering messages injected across all runs. */
	readonly steeringMessages: number;
	/** runs that entered the `paused` state at least once. */
	readonly runsPaused: number;
	/** runs whose pause hit the pause-timeout (stalled awaiting input). */
	readonly pauseTimeouts: number;
}

export interface InsightsInput {
	readonly metrics: RunMetrics;
	readonly mining: CommandMining;
	readonly steering?: SteeringSignals;
}

/** Minimum terminal runs before an agent's success rate is worth flagging. */
const MIN_AGENT_TERMINAL_RUNS = 3;
/** Success-rate thresholds for the worst-success-agent callout. */
const AGENT_CRITICAL_SUCCESS_RATE = 0.5;
const AGENT_WARNING_SUCCESS_RATE = 0.8;
/** A seed dominates when its context total is this multiple of the runner-up. */
const SEED_DOMINANCE_FACTOR = 2;
/** Failure-count thresholds for the most-failed-command callout. */
const COMMAND_CRITICAL_FAILURES = 5;
const COMMAND_WARNING_FAILURES = 2;
/** Stuck-score thresholds for the most-retried-command callout. */
const COMMAND_CRITICAL_STUCK = 3;
/** A model is a cost outlier when its avg ≥ this multiple of peers' median. */
const COST_OUTLIER_FACTOR = 2;
const MIN_MODELS_FOR_OUTLIER = 2;
/** Share-of-runs thresholds for the steering anomaly. */
const STEERING_CRITICAL_SHARE = 0.5;
const STEERING_WARNING_SHARE = 0.25;

const KIND_ORDER: readonly InsightKind[] = [
	"pause-anomaly",
	"worst-success-agent",
	"most-retried-command",
	"most-failed-command",
	"model-cost-outlier",
	"steering-anomaly",
	"highest-context-seed",
];

const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };

function pct(rate: number): string {
	return `${Math.round(rate * 100)}%`;
}

function highestContextSeed(metrics: RunMetrics): Insight | null {
	const [top, second] = metrics.topSeedsByContext;
	if (top === undefined || top.contextTokensTotal <= 0) return null;
	const dominant =
		second !== undefined &&
		second.contextTokensTotal > 0 &&
		top.contextTokensTotal >= second.contextTokensTotal * SEED_DOMINANCE_FACTOR;
	return {
		kind: "highest-context-seed",
		severity: dominant ? "warning" : "info",
		title: "Highest-context seed",
		detail: `Seed ${top.seedId} burned ${top.contextTokensTotal} context tokens across ${top.runs} run(s)${
			dominant ? " — far more than any other seed" : ""
		}.`,
		value: top.contextTokensTotal,
		subject: top.seedId,
	};
}

/**
 * Terminal-run count consistent with `RunGroupBucket.successRate`, which is
 * `succeeded / (succeeded + failed + cancelled)`. The bucket does not expose
 * `cancelled`, so recover the denominator from the reported rate when it is
 * positive; fall back to `succeeded + failed` only when the rate is 0 (where
 * `succeeded` is 0 and the rate carries no denominator information).
 */
function terminalRuns(g: RunGroupBucket): number {
	if (g.successRate !== null && g.successRate > 0) return Math.round(g.succeeded / g.successRate);
	return g.succeeded + g.failed;
}

function worstSuccessAgent(metrics: RunMetrics): Insight | null {
	let worst: RunGroupBucket | null = null;
	for (const g of metrics.byAgent) {
		if (g.successRate === null || terminalRuns(g) < MIN_AGENT_TERMINAL_RUNS) continue;
		if (worst === null || g.successRate < (worst.successRate ?? 1)) worst = g;
	}
	if (worst === null || worst.successRate === null) return null;
	if (worst.successRate >= AGENT_WARNING_SUCCESS_RATE) return null;
	return {
		kind: "worst-success-agent",
		severity: worst.successRate < AGENT_CRITICAL_SUCCESS_RATE ? "critical" : "warning",
		title: "Worst-performing agent",
		detail: `Agent "${worst.key}" succeeded in only ${pct(worst.successRate)} of ${terminalRuns(
			worst,
		)} terminal run(s).`,
		value: worst.successRate,
		subject: worst.key,
	};
}

function mostFailedCommand(mining: CommandMining): Insight | null {
	const top = mining.byFailures[0];
	if (top === undefined || top.failures < COMMAND_WARNING_FAILURES) return null;
	return {
		kind: "most-failed-command",
		severity: top.failures >= COMMAND_CRITICAL_FAILURES ? "critical" : "warning",
		title: "Most-failed command",
		detail: `"${top.command}" failed ${top.failures} of ${top.invocations} invocation(s)${
			top.osEco ? " (os-eco tooling)" : ""
		}.`,
		value: top.failures,
		subject: top.command,
	};
}

function mostRetriedCommand(mining: CommandMining): Insight | null {
	const top: CommandStat | undefined = mining.byStuckScore[0];
	if (top === undefined || top.stuckScore <= 0) return null;
	return {
		kind: "most-retried-command",
		severity: top.stuckScore >= COMMAND_CRITICAL_STUCK ? "critical" : "warning",
		title: "Stuck-command loop",
		detail: `"${top.command}" was re-run after failing and failed again ${top.stuckScore} time(s) (${top.retries} retr${
			top.retries === 1 ? "y" : "ies"
		}).`,
		value: top.stuckScore,
		subject: top.command,
	};
}

/** Average per-priced-run cost for a model bucket, or null when unpriced. */
function avgCostOf(g: RunGroupBucket): number | null {
	return g.priced === 0 ? null : g.costUsd / g.priced;
}

function medianOf(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function modelCostOutlier(metrics: RunMetrics): Insight | null {
	const priced = metrics.byModel
		.map((g) => ({ key: g.key, avg: avgCostOf(g) }))
		.filter((m): m is { key: string; avg: number } => m.avg !== null && m.avg > 0);
	if (priced.length < MIN_MODELS_FOR_OUTLIER) return null;
	let top = priced[0];
	if (top === undefined) return null;
	for (const m of priced) if (m.avg > top.avg) top = m;
	const peers = priced.filter((m) => m.key !== top.key).map((m) => m.avg);
	if (peers.length === 0) return null;
	const peerMedian = medianOf(peers);
	if (peerMedian <= 0 || top.avg < peerMedian * COST_OUTLIER_FACTOR) return null;
	return {
		kind: "model-cost-outlier",
		severity: "warning",
		title: "Model cost outlier",
		detail: `Model "${top.key}" averages $${top.avg.toFixed(4)}/run — ${(top.avg / peerMedian).toFixed(1)}× the median of its peers ($${peerMedian.toFixed(4)}).`,
		value: top.avg,
		subject: top.key,
	};
}

function steeringAnomaly(s: SteeringSignals): Insight | null {
	if (s.totalRuns <= 0 || s.runsSteered <= 0) return null;
	const share = s.runsSteered / s.totalRuns;
	if (share < STEERING_WARNING_SHARE) return null;
	return {
		kind: "steering-anomaly",
		severity: share >= STEERING_CRITICAL_SHARE ? "critical" : "warning",
		title: "Heavy mid-run steering",
		detail: `${s.runsSteered} of ${s.totalRuns} run(s) (${pct(share)}) needed mid-run steering — ${s.steeringMessages} message(s) total.`,
		value: share,
		subject: null,
	};
}

function pauseAnomaly(s: SteeringSignals): Insight | null {
	if (s.pauseTimeouts <= 0) return null;
	return {
		kind: "pause-anomaly",
		severity: "critical",
		title: "Runs stalled on pause",
		detail: `${s.pauseTimeouts} run(s) hit the pause timeout while awaiting input${
			s.runsPaused > 0 ? ` (${s.runsPaused} paused at least once)` : ""
		}.`,
		value: s.pauseTimeouts,
		subject: null,
	};
}

function compareInsights(a: Insight, b: Insight): number {
	const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
	if (sev !== 0) return sev;
	return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
}

/**
 * Distill the run-metrics + command-mining rollups (and optional steering
 * signals) into a ranked list of severity-coded callouts. Returns `[]` for a
 * healthy, low-signal window. O(groups + commands) — a handful of single
 * passes over the already-aggregated breakdowns.
 */
export function buildInsights(input: InsightsInput): Insight[] {
	const { metrics, mining, steering } = input;
	const candidates: (Insight | null)[] = [
		highestContextSeed(metrics),
		worstSuccessAgent(metrics),
		mostFailedCommand(mining),
		mostRetriedCommand(mining),
		modelCostOutlier(metrics),
	];
	if (steering !== undefined) {
		candidates.push(steeringAnomaly(steering), pauseAnomaly(steering));
	}
	const insights = candidates.filter((i): i is Insight => i !== null);
	insights.sort(compareInsights);
	return insights;
}

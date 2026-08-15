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
 * rollups (plus an optional {@link SteeringSignals} bundle) and derives at most
 * one {@link Insight} per category:
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
 *   - `steering-outcome-delta` (warren-be04): steered versus unsteered
 *     merged-PR rates, denominators + confidence attached
 *   - `cost-per-merged-pr` (warren-be04): total priced cost over merged-PR
 *     count, overall with the priciest bucket named
 *   - `context-waste-proxy` (warren-6d41): the tool whose tool_result byte
 *     share of run context tokens dominates — a byte-size proxy, not
 *     per-turn usage deltas, and the payload says so
 *
 * NOTE: the `steering-anomaly` callout fires only when a caller passes the
 * optional {@link SteeringSignals} bundle. The `GET /analytics/behavior`
 * handler now supplies it — it tallies steering counters via
 * `buildSteeringSignals` (over a dedicated event query) and passes `steering`
 * into `buildInsights` — so this kind appears in the live endpoint's response
 * whenever the underlying signal is present.
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

import type { InsightConfidence } from "../../core/wire.ts";
import type { CommandMining, CommandStat } from "./command-mining.ts";
import type { ContextWasteProxy } from "./context-waste.ts";
import type { DirectoryDifficulty } from "./directory-difficulty.ts";
import { contextWasteProxy } from "./insights-context-waste.ts";
import { hardestDirectory } from "./insights-directory.ts";
import type { RunOutcomes } from "./outcome-analytics.ts";
import type { RunGroupBucket, RunMetrics } from "./run-metrics.ts";

// The confidence vocabulary is canonical in the wire kernel (warren-be04);
// re-exported here so insight consumers keep one import site.
export type { InsightConfidence } from "../../core/wire.ts";

export type InsightSeverity = "info" | "warning" | "critical";

export type InsightKind =
	| "highest-context-seed"
	| "worst-success-agent"
	| "most-failed-command"
	| "most-retried-command"
	| "model-cost-outlier"
	| "steering-anomaly"
	| "steering-outcome-delta"
	| "cost-per-merged-pr"
	| "context-waste-proxy"
	| "hardest-directory";

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
	/**
	 * The count `value` was divided by (warren-be04). Outcome-joined
	 * callouts ship every rate/ratio with its denominator so the UI can
	 * render "12 of 34" next to "35%". Absent on count-shaped callouts.
	 */
	readonly denominator?: number;
	/**
	 * Confidence qualifier for outcome-joined callouts (warren-be04),
	 * derived from the sample behind `denominator`. Absent on callouts
	 * whose number is a raw count rather than a rate or ratio.
	 */
	readonly confidence?: InsightConfidence;
}

/**
 * Steering counters a caller may tally while scanning events. All optional —
 * when omitted (or zeroed) the steering insight is skipped. The
 * `GET /analytics/behavior` handler supplies this bundle (built by
 * `buildSteeringSignals`), so the steering insight is live there.
 */
export interface SteeringSignals {
	readonly totalRuns: number;
	/** runs that received at least one mid-run steering message. */
	readonly runsSteered: number;
	/** total steering messages injected across all runs. */
	readonly steeringMessages: number;
}

export interface InsightsInput {
	readonly metrics: RunMetrics;
	readonly mining: CommandMining;
	readonly steering?: SteeringSignals;
	/**
	 * Outcome-joined rollup (warren-be04) — steered/unsteered cohort
	 * outcomes plus cost-per-merged-PR. When supplied, `buildInsights`
	 * also derives the `steering-outcome-delta` and `cost-per-merged-pr`
	 * callouts.
	 */
	readonly outcomes?: RunOutcomes;
	/**
	 * Context-waste proxy rollup (warren-6d41) — tool_result byte shares
	 * against run context tokens from the `tool_calls` rollup. When
	 * supplied, `buildInsights` also derives the `context-waste-proxy`
	 * callout. The `GET /analytics/behavior` handler supplies it.
	 */
	readonly contextWaste?: ContextWasteProxy;
	/**
	 * Per-directory difficulty rollup (warren-8f1b). Optional like
	 * `steering`: when omitted the `hardest-directory` callout is
	 * skipped. Directories carry their own denominators + confidence.
	 */
	readonly directories?: DirectoryDifficulty;
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
/** Minimum resolved-PR rows per cohort before a delta is worth reporting. */
const MIN_OUTCOME_COHORT_KNOWN = 3;
const KIND_ORDER: readonly InsightKind[] = [
	"worst-success-agent",
	"most-retried-command",
	"most-failed-command",
	"model-cost-outlier",
	"cost-per-merged-pr",
	"steering-outcome-delta",
	"steering-anomaly",
	"context-waste-proxy",
	"hardest-directory",
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

/** Terminal-run count: succeeded + failed + cancelled. */
function terminalRuns(g: RunGroupBucket): number {
	return g.succeeded + g.failed + g.cancelled;
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

/**
 * Steered-versus-unsteered merged-PR rate delta (warren-be04). Fires only
 * when BOTH cohorts have at least {@link MIN_OUTCOME_COHORT_KNOWN} runs with
 * a resolved `prState` — below that the delta is noise. A negative delta
 * (steered runs land LESS often) is a warning; a non-negative one is info.
 * NULL `prState` rows sit in neither denominator.
 */
function steeringOutcomeDelta(outcomes: RunOutcomes): Insight | null {
	const { steered, unsteered, mergedPrRateDelta, confidence } = outcomes.steering;
	if (mergedPrRateDelta === null) return null;
	if (
		steered.prStateKnown < MIN_OUTCOME_COHORT_KNOWN ||
		unsteered.prStateKnown < MIN_OUTCOME_COHORT_KNOWN
	) {
		return null;
	}
	const steeredRate = steered.mergedPrRate;
	const unsteeredRate = unsteered.mergedPrRate;
	if (steeredRate === null || unsteeredRate === null) return null;
	const signed = `${mergedPrRateDelta >= 0 ? "+" : ""}${Math.round(mergedPrRateDelta * 100)}pts`;
	return {
		kind: "steering-outcome-delta",
		severity: mergedPrRateDelta < 0 ? "warning" : "info",
		title: "Steering-outcome delta",
		detail:
			`Steered runs merged ${steered.prsMerged} of ${steered.prStateKnown} resolved PR(s) ` +
			`(${pct(steeredRate)}); unsteered runs merged ${unsteered.prsMerged} of ` +
			`${unsteered.prStateKnown} (${pct(unsteeredRate)}) — a ${signed} delta.`,
		value: mergedPrRateDelta,
		subject: null,
		denominator: steered.prStateKnown + unsteered.prStateKnown,
		confidence,
	};
}

/**
 * Overall cost per merged PR (warren-be04): total priced cost over merged-PR
 * count, with the priciest agent/model/provider bucket named as the subject.
 * Fires only when at least one PR merged AND at least one run carried a
 * price — a zero-merged window has no ratio, and an unpriced window has no
 * cost numerator. Buckets with zero merged PRs never win the "priciest"
 * slot: their ratio is undefined, not infinite.
 */
function costPerMergedPr(outcomes: RunOutcomes): Insight | null {
	const c = outcomes.costPerMergedPr;
	if (c.overall.costPerMergedPrUsd === null || c.overall.priced === 0) return null;
	let worst: { dimension: string; key: string; ratio: number } | null = null;
	const dimensions = [
		["agent", c.byAgent],
		["model", c.byModel],
		["provider", c.byProvider],
	] as const;
	for (const [dimension, buckets] of dimensions) {
		for (const b of buckets) {
			if (b.costPerMergedPrUsd === null) continue;
			if (worst === null || b.costPerMergedPrUsd > worst.ratio) {
				worst = { dimension, key: b.key, ratio: b.costPerMergedPrUsd };
			}
		}
	}
	const ratio = c.overall.costPerMergedPrUsd;
	return {
		kind: "cost-per-merged-pr",
		severity: "info",
		title: "Cost per merged PR",
		detail:
			`$${ratio.toFixed(2)} of priced run cost per merged PR ` +
			`($${c.overall.costUsd.toFixed(2)} across ${c.overall.priced} priced run(s) over ` +
			`${c.overall.prsMerged} merged PR(s) of ${c.overall.prStateKnown} resolved)` +
			(worst === null
				? "."
				: ` — priciest ${worst.dimension}: "${worst.key}" at $${worst.ratio.toFixed(2)}/merged PR.`),
		value: ratio,
		subject: worst?.key ?? null,
		denominator: c.overall.prsMerged,
		confidence: c.confidence,
	};
}

function compareInsights(a: Insight, b: Insight): number {
	const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
	if (sev !== 0) return sev;
	return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
}

/**
 * Event kind emitted by `steerRun` when a steering message is forwarded to
 * the burrow inbox. Mirrored here so the analytics layer does not import from
 * the run-lifecycle module.
 */
const STEER_SENT_KIND = "steer.sent";

/**
 * The minimal event shape the steering-signals aggregator needs. Matches the
 * subset of `EventRow` used here so callers can pass the full row without an
 * explicit cast.
 */
export interface SteeringEventRow {
	readonly runId: string;
	readonly kind: string;
}

/**
 * Aggregate steering counters from the raw event rows produced by
 * `EventsRepo.listSteeringEventsForRuns`. Returns a populated
 * {@link SteeringSignals} bundle ready to pass to {@link buildInsights}.
 *
 * Complexity is O(n) in the number of event rows.
 *
 * @param rows - Events with kind `steer.sent` for all runs in the analytics
 *   window.
 * @param totalRuns - Total run count in the window (denominator for rates).
 */
export function buildSteeringSignals(
	rows: readonly SteeringEventRow[],
	totalRuns: number,
): SteeringSignals {
	const steeredRunIds = new Set<string>();
	let steeringMessages = 0;
	for (const row of rows) {
		if (row.kind === STEER_SENT_KIND) {
			steeredRunIds.add(row.runId);
			steeringMessages++;
		}
	}
	return {
		totalRuns,
		runsSteered: steeredRunIds.size,
		steeringMessages,
	};
}

/**
 * Per-run steering-message counts (warren-8f1b): the same `steer.sent`
 * scan as {@link buildSteeringSignals}, keyed by run id, for aggregators
 * that join steering to a per-run subject (the directory difficulty map).
 */
export function countSteeringByRun(rows: readonly SteeringEventRow[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row.kind !== STEER_SENT_KIND) continue;
		counts.set(row.runId, (counts.get(row.runId) ?? 0) + 1);
	}
	return counts;
}

/**
 * Distill the run-metrics + command-mining rollups (and optional steering
 * signals) into a ranked list of severity-coded callouts. Returns `[]` for a
 * healthy, low-signal window. O(groups + commands) — a handful of single
 * passes over the already-aggregated breakdowns.
 */
export function buildInsights(input: InsightsInput): Insight[] {
	const { metrics, mining, steering, directories, outcomes } = input;
	const candidates: (Insight | null)[] = [
		highestContextSeed(metrics),
		worstSuccessAgent(metrics),
		mostFailedCommand(mining),
		mostRetriedCommand(mining),
		modelCostOutlier(metrics),
	];
	if (steering !== undefined) {
		candidates.push(steeringAnomaly(steering));
	}
	if (outcomes !== undefined) {
		candidates.push(steeringOutcomeDelta(outcomes));
		candidates.push(costPerMergedPr(outcomes));
	}
	if (directories !== undefined) {
		candidates.push(hardestDirectory(directories));
	}
	if (input.contextWaste !== undefined) {
		candidates.push(contextWasteProxy(input.contextWaste));
	}
	const insights = candidates.filter((i): i is Insight => i !== null);
	insights.sort(compareInsights);
	return insights;
}

/* ----------------------------------------------------------------------- */
/* Run analytics wire types (warren-df6e / pl-ad0f step 4; split out of    */
/* client.ts under the file-size budget, warren-be04). Mirror the server   */
/* shapes in src/runs/analytics/*.ts; re-exported from ./client.ts so      */
/* existing import sites are unchanged.                                    */
/* ----------------------------------------------------------------------- */

import type { InsightConfidence } from "../../../core/wire.ts";
import type { RunAnalyticsTokensSection, TokenBreakdown } from "./types.ts";

/** Sentinel key for a null group (no startedAt, model, provider, etc.). */
export const RUN_ANALYTICS_NONE_KEY = "__none__";
/** Sentinel key for the folded remainder in per-dimension token series (≥6 keys). */
export const RUN_ANALYTICS_OTHER_KEY = "__other__";

/** avg/median/p95 over the non-null sample, all-null when empty. */
export interface RunStatSummary {
	avg: number | null;
	median: number | null;
	p95: number | null;
	count: number;
}

/**
 * Delivery-timing rollup (warren-bc9c): median-shaped gaps between
 * dispatch, branch push, PR open, and merge. Each summary samples only
 * the runs where both endpoints of the gap are known.
 */
export interface RunDeliveryMetrics {
	/** `reap.pr_opened` ts − `reap.branch_pushed` ts. */
	branchPushToPrOpenMs: RunStatSummary;
	/** `runs.pr_merged_at` − `reap.pr_opened` ts. */
	prOpenToMergeMs: RunStatSummary;
	/** `runs.pr_merged_at` − `runs.created_at`. */
	dispatchToMergeMs: RunStatSummary;
	/** `runs.pr_merged_at` − `runs.ended_at`. */
	endToMergeMs: RunStatSummary;
}

export interface RunAnalyticsTotals {
	runs: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	active: number;
	successRate: number | null;
	/**
	 * Landed-work rollup (warren-bd57): `prStateKnown` rows carry a resolved
	 * PR lifecycle (the merge-rate denominator — NULL `pr_state` rows are
	 * unknown, never failures), `prsMerged` of them merged. Rate is null
	 * when no run in the window has a resolved PR state.
	 */
	prStateKnown: number;
	prsMerged: number;
	mergedPrRate: number | null;
	durationMs: RunStatSummary;
	/**
	 * Queue wait (`startedAt - createdAt`) over rows where both are known
	 * (warren-0af9). Pre-migration rows (null `createdAt`) are excluded from
	 * the sample — `count` is the known-row denominator.
	 */
	queueWaitMs: RunStatSummary;
	contextTokens: RunStatSummary;
	/**
	 * OPTIONAL on the wire: the windowed USD rollup is redacted for a
	 * `readPublic`-only caller (`REDACTED_RUN_TOTALS_FIELDS` in
	 * `src/server/handlers/runs/analytics.ts`), so a spectator's envelope has
	 * no such key. Callers must render on presence — dereferencing without a
	 * guard crashed `/run-analytics` for anonymous visitors (warren-e274).
	 */
	cost?: { total: number; avg: number | null; priced: number };
}

export interface RunDayBucket {
	key: string;
	runs: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	active: number;
	contextTokensTotal: number;
}

export interface RunGroupBucket {
	key: string;
	runs: number;
	succeeded: number;
	failed: number;
	successRate: number | null;
	/** Landed-work rollup for this bucket (warren-bd57) — see totals. */
	prStateKnown: number;
	prsMerged: number;
	mergedPrRate: number | null;
	contextTokensTotal: number;
	avgContextTokens: number | null;
	tokens: TokenBreakdown;
	/**
	 * OPTIONAL on the wire: per-group USD spend is redacted for a
	 * `readPublic`-only caller (`REDACTED_RUN_GROUP_FIELDS` in
	 * `src/server/handlers/runs/analytics.ts`); summing per-group cost would
	 * reconstruct the aggregate the totals projection just dropped. Callers
	 * must render on presence (warren-e274).
	 */
	costUsd?: number;
	priced?: number;
	avgDurationMs: number | null;
}

export interface RunFailureBucket {
	key: string;
	runs: number;
}

export interface SeedContextBucket {
	seedId: string;
	runs: number;
	contextTokensTotal: number;
	avgContextTokens: number | null;
}

export interface RunAnalyticsResponse {
	filter: { projectId: string | null; from: string | null; to: string | null };
	totals: RunAnalyticsTotals;
	timeSeries: RunDayBucket[];
	byAgent: RunGroupBucket[];
	byModel: RunGroupBucket[];
	byProvider: RunGroupBucket[];
	byFailureReason: RunFailureBucket[];
	topSeedsByContext: SeedContextBucket[];
	/** Token analytics section added by warren-1244 / pl-d1a2 step 2. */
	tokens: RunAnalyticsTokensSection;
	/** Outcome-joined rollup (warren-be04); USD fields optional — spectator-redacted. */
	outcomes: RunOutcomes;
	/** Delivery-timing rollup (warren-bc9c) — public like queueWaitMs. */
	delivery: RunDeliveryMetrics;
}

export interface RunAnalyticsFilter {
	projectId?: string;
	from?: string;
	to?: string;
}

/* ----------------------------------------------------------------------- */
/* Run behavior analytics — command mining + insights (warren-436a /       */
/* pl-ad0f step 10). Mirrors the server shapes in                          */
/* src/runs/analytics/command-mining.ts + insights.ts.                     */
/* ----------------------------------------------------------------------- */

/** Generalized command category — `os-eco` rows are highlighted in the UI. */
export type CommandCategory =
	| "os-eco"
	| "vcs"
	| "package"
	| "build"
	| "test"
	| "filesystem"
	| "network"
	| "other";

export interface CommandStat {
	command: string;
	category: CommandCategory;
	osEco: boolean;
	runs: number;
	invocations: number;
	failures: number;
	failureRate: number | null;
	retries: number;
	stuckScore: number;
}

export interface CommandCategoryBucket {
	category: CommandCategory;
	invocations: number;
	failures: number;
	commands: number;
}

export interface CommandMiningTotals {
	toolUses: number;
	commands: number;
	distinctCommands: number;
	failures: number;
	retries: number;
}

export interface CommandMining {
	totals: CommandMiningTotals;
	byFrequency: CommandStat[];
	byFailures: CommandStat[];
	byStuckScore: CommandStat[];
	osEcoCommands: CommandStat[];
	byCategory: CommandCategoryBucket[];
}

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

// The confidence qualifier vocabulary is canonical in the wire kernel
// (src/core/wire-insight.ts, warren-be04) — re-exported, never
// redeclared. tsconfig.app.json includes ../core/wire-insight.ts.
export type { InsightConfidence };

export interface Insight {
	kind: InsightKind;
	severity: InsightSeverity;
	title: string;
	detail: string;
	value: number;
	subject: string | null;
	/** the count `value` was divided by — outcome-joined kinds only (warren-be04). */
	denominator?: number;
	confidence?: InsightConfidence;
}

/* Outcome-joined rollups (warren-be04 / pl-103e step 12). Mirrors          */
/* src/runs/analytics/outcome-analytics.ts. Cost fields are optional: they   */
/* are spectator-redacted from the /analytics/runs public projection.        */

export interface OutcomeTally {
	runs: number;
	terminal: number;
	succeeded: number;
	successRate: number | null;
	prStateKnown: number;
	prsMerged: number;
	mergedPrRate: number | null;
}

export interface SteeringOutcomeComparison {
	steered: OutcomeTally;
	unsteered: OutcomeTally;
	mergedPrRateDelta: number | null;
	confidence: InsightConfidence;
}

export interface CostPerMergedPrBucket {
	key: string;
	costUsd?: number;
	priced?: number;
	prStateKnown: number;
	prsMerged: number;
	costPerMergedPrUsd?: number | null;
}

export interface CostPerMergedPr {
	overall: {
		costUsd?: number;
		priced?: number;
		prStateKnown: number;
		prsMerged: number;
		costPerMergedPrUsd?: number | null;
	};
	byAgent: CostPerMergedPrBucket[];
	byModel: CostPerMergedPrBucket[];
	byProvider: CostPerMergedPrBucket[];
	confidence: InsightConfidence;
}

/** Autonomy rollup (warren-bc9c): merged runs needing no human in the loop. */
export interface AutonomyRollup {
	/** rows whose `prState` is `merged` — the rate's denominator. */
	merged: number;
	/** merged rows that were never steered and are first attempts. */
	autonomous: number;
	/** autonomous / merged, or null when nothing merged. */
	rate: number | null;
}

export interface RunOutcomes {
	steering: SteeringOutcomeComparison;
	costPerMergedPr: CostPerMergedPr;
	/** Autonomy rollup (warren-bc9c) — public, counts + a rate. */
	autonomy: AutonomyRollup;
}

/* Context-waste proxy (warren-6d41 / pl-103e step 11). Mirrors             */
/* src/runs/analytics/context-waste.ts. The share is a byte-size proxy      */
/* against run-level context-token totals, NOT per-turn usage deltas.       */

export interface ContextWasteShare {
	key: string;
	invocations: number;
	resultBytesKnown: number;
	resultBytesTotal: number;
	runs: number;
	/** invoking runs with known context tokens — the share's cohort. */
	runsMeasured: number;
	contextTokensTotal: number;
	share: number | null;
}

export interface ContextWasteProxy {
	runsInWindow: number;
	/** runs with at least one rollup row — the rollup-era cohort. */
	runsWithRollup: number;
	/** rollup rows AND known context tokens — the share denominator. */
	runsMeasured: number;
	contextTokensTotal: number;
	resultBytesTotal: number;
	share: number | null;
	byTool: ContextWasteShare[];
	byCommand: ContextWasteShare[];
	confidence: InsightConfidence;
}

/* Per-directory difficulty rollup (warren-8f1b / pl-103e step 10).      */
/* Mirrors src/runs/analytics/directory-difficulty.ts. Operator-only:    */
/* directory names are repo layout, and /analytics/behavior is           */
/* readOperator, so this shape never crosses the public projection.      */

export interface DirectoryStat {
	directory: string;
	/** Denominator: distinct runs with at least one file touch here. */
	runsTouching: number;
	runsFailed: number;
	failureShare: number | null;
	fileTouches: number;
	errorTouches: number;
	retries: number;
	steeringMessages: number;
	difficultyScore: number;
	confidence: InsightConfidence;
}

export interface DirectoryDifficultyTotals {
	runsInWindow: number;
	/** Runs with at least one extracted path — the KNOWN subset. */
	runsWithFilePaths: number;
	fileTouches: number;
	directoriesRanked: number;
	directoriesBelowMinN: number;
}

export interface DirectoryDifficulty {
	directories: DirectoryStat[];
	totals: DirectoryDifficultyTotals;
}

export interface RunBehaviorResponse {
	filter: { projectId: string | null; from: string | null; to: string | null };
	mining: CommandMining;
	insights: Insight[];
	outcomes: RunOutcomes;
	/** warren-6d41: context-waste proxy — byte shares + denominators. */
	contextWaste: ContextWasteProxy;
	/** warren-8f1b: per-directory difficulty — ranked buckets + denominators. */
	directories: DirectoryDifficulty;
	/** warren-7746: true when the rollup read hit its row cap — rankings
	 * then cover a bounded prefix. Reported, never silent. */
	truncated: boolean;
}

/**
 * Ops-overview snapshot (pl-7e38 step 12 / warren-d850).
 *
 * One call builds the whole control-plane snapshot behind `GET /ops/overview`:
 * run lifecycle counts by state, spend rate (all-time + recent-window cost
 * aggregates), delivery stats (branches pushed / PRs opened / PRs merged),
 * and the pending operator-intervention count (unread steering-inbox rows).
 * Everything is a single SQL aggregate query — no run bodies are loaded and
 * nothing loops per run. The service-health facts (runtime provider kind,
 * lifecycle-stream wiring) are injected by the handler from `ServerDeps`;
 * `dbReachable` is derived here from whether the aggregate queries actually
 * succeeded, so a snapshot is never served with stale counts masquerading
 * as fresh ones — a failed db zeroes every db-backed section.
 */

import { eq, gt, sql } from "drizzle-orm";
import type { RunState } from "../core/wire.ts";
import type { SqliteDrizzleDb } from "../db/client.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { countRunsByState } from "../db/repos/runs-stats.ts";
import type { RuntimeProviderKind } from "../runtime/contract.ts";

/** Recent-cost window: epoch-ms cutoff for the trailing 24h spend bucket. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Run lifecycle counts, dense across `RUN_STATES`. */
export interface OpsRunCounts {
	readonly byState: Readonly<Record<RunState, number>>;
	/** `queued` + `running` — runs still occupying an admission slot. */
	readonly nonTerminal: number;
	readonly total: number;
}

/** Spend-rate section. USD sums over the persisted `cost_usd` column. */
export interface OpsSpend {
	/** All-time USD across every run. */
	readonly totalUsd: number;
	/** USD across runs queued in the trailing 24h window. */
	readonly last24hUsd: number;
	/** How many runs the 24h window covers. */
	readonly last24hRuns: number;
}

/** Delivery stats — what reap handed to the forge. */
export interface OpsDelivery {
	/**
	 * Runs whose reap measured a pushed branch (reap-time outcome facts
	 * recorded — the branch push ran far enough to be diffed). Null
	 * `commits_ahead` is "unknown", never "no push", so it is excluded.
	 */
	readonly branchesPushed: number;
	/** Runs with a `pr_url` — auto-open landed. */
	readonly prsOpened: number;
	/** Runs whose merge watcher recorded `pr_state = "merged"`. */
	readonly prsMerged: number;
}

/** Pending operator interventions — unread steering-inbox rows. */
export interface OpsInterventions {
	/** Unread inbox rows across every run, by priority class. */
	readonly pendingByPriority: Readonly<Record<string, number>>;
	readonly pendingTotal: number;
}

/** Cheap control-plane service-health facts (no probes — derived truth). */
export interface OpsServices {
	readonly dbReachable: boolean;
	readonly runtime: RuntimeProviderKind;
	/** Global lifecycle stream (`GET /events/stream`) is wired at boot. */
	readonly lifecycleStream: boolean;
}

/** Full operator snapshot served by `GET /ops/overview`. */
export interface OpsOverview {
	readonly runs: OpsRunCounts;
	readonly spend: OpsSpend;
	readonly delivery: OpsDelivery;
	readonly interventions: OpsInterventions;
	readonly services: OpsServices;
	/** ISO8601 instant the snapshot was taken. */
	readonly generatedAt: string;
}

/** Facts the handler derives from `ServerDeps` and injects. */
export interface OpsServiceFacts {
	readonly runtime: RuntimeProviderKind;
	readonly lifecycleStream: boolean;
}

/** An `OpsOverview` with every db-backed section zeroed. */
export function degradedOpsOverview(facts: OpsServiceFacts, now: Date): OpsOverview {
	return {
		runs: {
			byState: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
			nonTerminal: 0,
			total: 0,
		},
		spend: { totalUsd: 0, last24hUsd: 0, last24hRuns: 0 },
		delivery: { branchesPushed: 0, prsOpened: 0, prsMerged: 0 },
		interventions: { pendingByPriority: {}, pendingTotal: 0 },
		services: {
			dbReachable: false,
			runtime: facts.runtime,
			lifecycleStream: facts.lifecycleStream,
		},
		generatedAt: now.toISOString(),
	};
}

/**
 * Build the snapshot. Any db failure collapses to the degraded shape
 * (`services.dbReachable: false`) rather than a partial body — the operator
 * console must never read zero counters as "quiet instance" when the truth
 * is "no database".
 */
export async function buildOpsOverview(
	adapter: DrizzleAdapter | undefined,
	facts: OpsServiceFacts,
	now: Date = new Date(),
): Promise<OpsOverview> {
	if (adapter === undefined) return degradedOpsOverview(facts, now);
	try {
		const [byState, spend, delivery, inbox] = await Promise.all([
			countRunsByState(adapter),
			aggregateSpend(adapter, now.getTime()),
			aggregateDelivery(adapter),
			aggregatePendingInbox(adapter),
		]);
		const total = Object.values(byState).reduce((a, b) => a + b, 0);
		const nonTerminal = (byState.queued ?? 0) + (byState.running ?? 0);
		return {
			runs: { byState, nonTerminal, total },
			spend,
			delivery,
			interventions: inbox,
			services: {
				dbReachable: true,
				runtime: facts.runtime,
				lifecycleStream: facts.lifecycleStream,
			},
			generatedAt: now.toISOString(),
		};
	} catch {
		return degradedOpsOverview(facts, now);
	}
}

async function aggregateSpend(adapter: DrizzleAdapter, nowMs: number): Promise<OpsSpend> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const [allTime] = await adapter.pickAll<{ costUsd: number | string | null }>(
		db.select({ costUsd: sql<number>`coalesce(sum(${runs.costUsd}), 0)`.as("costUsd") }).from(runs),
	);
	const [recent] = await adapter.pickAll<{
		costUsd: number | string | null;
		count: number | string;
	}>(
		db
			.select({
				costUsd: sql<number>`coalesce(sum(${runs.costUsd}), 0)`.as("costUsd"),
				count: sql<number>`count(*)`.as("count"),
			})
			.from(runs)
			.where(gt(runs.createdAt, nowMs - DAY_MS)),
	);
	return {
		totalUsd: Number(allTime?.costUsd ?? 0),
		last24hUsd: Number(recent?.costUsd ?? 0),
		last24hRuns: Number(recent?.count ?? 0),
	};
}

async function aggregateDelivery(adapter: DrizzleAdapter): Promise<OpsDelivery> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const [row] = await adapter.pickAll<{
		branchesPushed: number | string;
		prsOpened: number | string;
		prsMerged: number | string;
	}>(
		db
			.select({
				branchesPushed: sql<number>`count(${runs.commitsAhead})`.as("branchesPushed"),
				prsOpened: sql<number>`count(${runs.prUrl})`.as("prsOpened"),
				prsMerged: sql<number>`count(*) filter (where ${runs.prState} = 'merged')`.as("prsMerged"),
			})
			.from(runs),
	);
	return {
		branchesPushed: Number(row?.branchesPushed ?? 0),
		prsOpened: Number(row?.prsOpened ?? 0),
		prsMerged: Number(row?.prsMerged ?? 0),
	};
}

async function aggregatePendingInbox(adapter: DrizzleAdapter): Promise<OpsInterventions> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runInbox = adapter.schema.runInbox;
	const rows = await adapter.pickAll<{ priority: string; count: number | string }>(
		db
			.select({ priority: runInbox.priority, count: sql<number>`count(*)`.as("count") })
			.from(runInbox)
			.where(eq(runInbox.state, "unread"))
			.groupBy(runInbox.priority),
	);
	const pendingByPriority: Record<string, number> = {};
	let pendingTotal = 0;
	for (const r of rows) {
		const n = Number(r.count);
		pendingByPriority[r.priority] = n;
		pendingTotal += n;
	}
	return { pendingByPriority, pendingTotal };
}

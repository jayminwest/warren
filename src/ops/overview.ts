/**
 * Ops-overview snapshot domain module (warren-d850 / pl-7e38 step 12,
 * Direction C operator-console revamp).
 *
 * The Operations dashboard (warren-d903) needs ONE poll that answers "what
 * is the control plane doing right now": run lifecycle counts by state,
 * spend rate (recent run cost aggregates), delivery stats (branches pushed
 * / PRs opened / PRs merged), pending operator interventions (steering
 * inbox rows not yet delivered), and the control-plane service health
 * facts the server can derive cheaply (db reachable, runtime provider
 * kind, event bus wired).
 *
 * Everything is a SQL-side aggregate (`src/db/repos/runs-stats.ts`) — no
 * per-run loops, no run bodies loaded. The builder is pure over its input
 * seams so the handler stays a thin surface (the same posture as the
 * periodic `ops.stats` log line, src/runs/ops-stats.ts).
 */

import { type AnyWarrenDb, pingDatabase } from "../db/client.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import {
	aggregateRunCost,
	aggregateRunCostSince,
	countRunDeliveryStats,
	countRunInboxByState,
	countRunsByState,
} from "../db/repos/runs-stats.ts";
import type { InboxState, RunState } from "../db/schema.ts";
import type { RuntimeProviderKind } from "../runtime/contract.ts";

/** The spend-rate lookback window: the last 24h of run creation. */
export const OPS_OVERVIEW_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OPS_OVERVIEW_SPEND_WINDOW_HOURS = OPS_OVERVIEW_SPEND_WINDOW_MS / (60 * 60 * 1000);

/** Spend-rate section: recent-window + all-time cost aggregates. */
export interface OpsOverviewSpend {
	readonly windowHours: number;
	readonly recentCostUsd: number;
	readonly totalCostUsd: number;
}

/** Delivery section: what agent work actually shipped. */
export interface OpsOverviewDelivery {
	readonly branchesPushed: number;
	readonly prsOpened: number;
	readonly prsMerged: number;
}

/**
 * Pending-operator-intervention section: the steering inbox. `byState` is
 * dense over INBOX_STATES; `pending` counts `unread` + `failed` — rows the
 * operator (or a healer) wrote that the target run has not yet drained.
 */
export interface OpsOverviewInbox {
	readonly byState: Record<InboxState, number>;
	readonly pending: number;
}

/** Cheap control-plane health facts, derived without leaving the process. */
export interface OpsOverviewHealth {
	readonly db: {
		readonly wired: boolean;
		readonly reachable: boolean;
		readonly dialect: "sqlite" | "postgres" | null;
	};
	readonly runtimeKind: RuntimeProviderKind;
	readonly eventBusWired: boolean;
}

/** The full operator snapshot served by `GET /ops/overview`. */
export interface OpsOverview {
	readonly runsByState: Record<RunState, number>;
	readonly spend: OpsOverviewSpend;
	readonly delivery: OpsOverviewDelivery;
	readonly inbox: OpsOverviewInbox;
	readonly health: OpsOverviewHealth;
}

/** Builder input — the boot-wired seams, threaded by the handler. */
export interface OpsOverviewInput {
	/** Boot-wired drizzle adapter (`deps.dbAdapter`). Absent ⇒ degraded zeros. */
	readonly adapter?: DrizzleAdapter;
	/** Live db handle (`deps.db`) for the reachability ping + dialect. */
	readonly db?: AnyWarrenDb;
	readonly runtimeKind: RuntimeProviderKind;
	/** `deps.lifecycleStream !== undefined` — the Tier-1 bus feeds it at boot. */
	readonly eventBusWired: boolean;
	/** Clock seam (tests). Defaults to `Date.now`. */
	readonly now?: () => number;
}

function zeroStates(): Record<RunState, number> {
	return Object.fromEntries(
		(["queued", "running", "succeeded", "failed", "cancelled"] as const).map((s) => [s, 0]),
	) as Record<RunState, number>;
}

/**
 * Collect one ops-overview snapshot. When `adapter` is unwired (tests,
 * partial deps) the aggregate sections are degraded zeros — the same
 * posture as the `/metrics` handler — so the endpoint never throws.
 */
export async function buildOpsOverview(input: OpsOverviewInput): Promise<OpsOverview> {
	const adapter = input.adapter;
	const dbDialect = input.db?.dialect ?? null;

	if (adapter === undefined) {
		return {
			runsByState: zeroStates(),
			spend: {
				windowHours: OPS_OVERVIEW_SPEND_WINDOW_HOURS,
				recentCostUsd: 0,
				totalCostUsd: 0,
			},
			delivery: { branchesPushed: 0, prsOpened: 0, prsMerged: 0 },
			inbox: {
				byState: { unread: 0, delivered: 0, failed: 0 },
				pending: 0,
			},
			health: {
				db: { wired: false, reachable: false, dialect: dbDialect },
				runtimeKind: input.runtimeKind,
				eventBusWired: input.eventBusWired,
			},
		};
	}

	const now = input.now ?? (() => Date.now());
	const sinceEpochMs = now() - OPS_OVERVIEW_SPEND_WINDOW_MS;
	const [runsByState, totalCost, recentCost, delivery, byState] = await Promise.all([
		countRunsByState(adapter),
		aggregateRunCost(adapter),
		aggregateRunCostSince(adapter, sinceEpochMs),
		countRunDeliveryStats(adapter),
		countRunInboxByState(adapter),
	]);

	let reachable = false;
	if (input.db !== undefined) {
		try {
			await pingDatabase(input.db);
			reachable = true;
		} catch {
			reachable = false;
		}
	}

	return {
		runsByState,
		spend: {
			windowHours: OPS_OVERVIEW_SPEND_WINDOW_HOURS,
			recentCostUsd: recentCost.costUsd,
			totalCostUsd: totalCost.costUsd,
		},
		delivery,
		inbox: {
			byState,
			pending: byState.unread + byState.failed,
		},
		health: {
			db: { wired: true, reachable, dialect: dbDialect },
			runtimeKind: input.runtimeKind,
			eventBusWired: input.eventBusWired,
		},
	};
}

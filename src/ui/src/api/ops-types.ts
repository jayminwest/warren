/* ----------------------------------------------------------------------- */
/* Ops overview wire types (pl-7e38 step 13 / warren-d903; split out of    */
/* types.ts under the file-size budget, same pattern as                    */
/* run-analytics-types.ts).                                                */
/* ----------------------------------------------------------------------- */

import type { OpsWindow, RunState } from "../../../core/wire.ts";

/**
 * Wire envelope of `GET /ops/overview` (pl-7e38 step 12 / warren-d850).
 * The operator body carries every section; a `WARREN_AUTH=public`
 * spectator is served the reduced projection (USD sums stripped; windowRuns,
 * delivery, and the service facts stay — warren-7194), so the operator-only
 * fields are OPTIONAL here and render on presence — an absent field must
 * never read as zero (warren-f53e, same rule as `costTotalUsd`).
 */
export interface OpsOverviewResponse {
	readonly runs: {
		readonly byState: Readonly<Partial<Record<RunState, number>>>;
		readonly nonTerminal: number;
		readonly total: number;
	};
	/** Trailing window the spend/delivery buckets cover (warren-7194). */
	readonly window: OpsWindow;
	readonly spend?: {
		readonly totalUsd?: number;
		readonly windowUsd?: number;
		readonly windowRuns: number;
	};
	readonly delivery?: {
		readonly branchesPushed: number;
		readonly prsOpened: number;
		readonly prsMerged: number;
	};
	readonly services?: {
		readonly dbReachable: boolean;
		readonly runtime: string;
		readonly lifecycleStream: boolean;
	};
	readonly generatedAt: string;
}

/* ----------------------------------------------------------------------- */
/* Ops overview wire types (pl-7e38 step 13 / warren-d903; split out of    */
/* types.ts under the file-size budget, same pattern as                    */
/* run-analytics-types.ts).                                                */
/* ----------------------------------------------------------------------- */

import type { RunState } from "../../../core/wire.ts";

/**
 * Wire envelope of `GET /ops/overview` (pl-7e38 step 12 / warren-d850).
 * The operator body carries every section; a `WARREN_AUTH=public`
 * spectator is served the reduced projection (run lifecycle counts +
 * `generatedAt` only), so every operator section is OPTIONAL here and
 * renders on presence — an absent section must never read as zero
 * (warren-f53e, same rule as `costTotalUsd`).
 */
export interface OpsOverviewResponse {
	readonly runs: {
		readonly byState: Readonly<Partial<Record<RunState, number>>>;
		readonly nonTerminal: number;
		readonly total: number;
	};
	readonly spend?: {
		readonly totalUsd: number;
		readonly last24hUsd: number;
		readonly last24hRuns: number;
	};
	readonly delivery?: {
		readonly branchesPushed: number;
		readonly prsOpened: number;
		readonly prsMerged: number;
	};
	readonly interventions?: {
		readonly pendingByPriority: Readonly<Record<string, number>>;
		readonly pendingTotal: number;
	};
	readonly services?: {
		readonly dbReachable: boolean;
		readonly runtime: string;
		readonly lifecycleStream: boolean;
	};
	readonly generatedAt: string;
}

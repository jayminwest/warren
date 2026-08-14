/**
 * Tool-calls rollup backfill boot wiring (warren-7746 / pl-103e step 9).
 * Extracted from `main/index.ts` to hold the boot entry under its
 * 500-line budget — the same pattern as `workspace-gc-wiring.ts`.
 *
 * Re-extracts structured `tool_calls` rows for runs that predate the
 * rollup. Windowed (30d) + capped (100 runs) per pass and
 * FIRE-AND-FORGET by design — the plan's risk note forbids blocking
 * boot on historical re-extraction, and each subsequent boot
 * incrementally picks up the next window's worth. See
 * `src/runs/tool-calls-backfill.ts`.
 */

import type { Repos } from "../../db/repos/index.ts";
import { backfillToolCallRollup } from "../../runs/tool-calls-backfill.ts";
import type { Logger } from "../types.ts";

export interface BootToolCallsBackfillInput {
	readonly repos: Repos;
	readonly logger: Logger;
}

/** Kick one backfill pass; never awaited, never crashes boot. */
export function bootToolCallsBackfill(input: BootToolCallsBackfillInput): void {
	void backfillToolCallRollup(input.repos, { logger: input.logger }).catch((err) => {
		input.logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"tool-calls rollup backfill failed; will retry next boot",
		);
	});
}

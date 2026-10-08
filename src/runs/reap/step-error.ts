/**
 * Build a reap step's error record. A `WarrenError` keeps its stable `code`
 * and `recoveryHint`, so the `reap_failed` event names the specific reason
 * (e.g. `legacy_worktree_workspace` for a pre-warren-3c1e local run) rather
 * than only a message.
 */

import { WarrenError } from "../../core/errors.ts";
import type { ReapStep, ReapStepError } from "./types.ts";

export function reapStepError(step: ReapStep, err: unknown, path?: string): ReapStepError {
	const message = err instanceof Error ? err.message : String(err);
	const detail =
		err instanceof WarrenError
			? {
					code: err.code,
					...(err.recoveryHint !== undefined ? { recoveryHint: err.recoveryHint } : {}),
				}
			: {};
	return { step, message, ...(path !== undefined ? { path } : {}), ...detail };
}

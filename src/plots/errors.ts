/**
 * Errors specific to per-Plot handlers (warren-896f / pl-9d6a step 9 +
 * later mutation steps).
 *
 * `PlotIntentFrozenError` is raised by `POST /plots/:id/intent` when the
 * target Plot's current status is `done` or `archived` — SPEC §6 freezes
 * the intent body once a Plot transitions out of the active phase.
 * Mapped to 409 in `src/server/errors.ts` (state-transition shape) so
 * HTTP consumers can branch on `code === "plot_intent_frozen"`.
 */

import { WarrenError } from "../core/errors.ts";

export class PlotIntentFrozenError extends WarrenError {
	readonly code = "plot_intent_frozen";
}

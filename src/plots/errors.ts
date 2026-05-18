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

/**
 * Raised by `POST /plots/:id/status` (warren-e868 / pl-9d6a step 10)
 * when the requested `next` status is not in the SPEC §6.5 whitelist for
 * the Plot's current status. Mapped to 409 in `src/server/errors.ts`
 * (state-transition shape) so HTTP consumers can branch on
 * `code === "plot_illegal_status_transition"`.
 *
 * The handler validates the transition matrix at the edge — before
 * opening a `UserPlotClient` — so warren never constructs an invalid
 * transition. The `@os-eco/plot-cli` library also rejects illegal
 * transitions internally (defense in depth); the typed warren error
 * fires first when the request comes through our HTTP surface.
 */
export class PlotIllegalStatusTransitionError extends WarrenError {
	readonly code = "plot_illegal_status_transition";
}

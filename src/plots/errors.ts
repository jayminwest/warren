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

/**
 * Raised by `DELETE /plots/:id/attachments/:ref` (warren-589c /
 * pl-9d6a step 11) when the supplied `ref` does not match any
 * attachment currently on the Plot. Mapped to 404 in
 * `src/server/errors.ts` so HTTP consumers can branch on
 * `code === "plot_attachment_not_found"`.
 *
 * The wire contract is keyed by external `ref` rather than the
 * lib's `att-NNN` id (see seed body — "DELETE detaches by ref"),
 * so this error surfaces when the resolver can't find a matching
 * attachment to translate the ref into an id for
 * `PlotHandle.detach`. A concurrent removal between the UI's last
 * GET and the DELETE round-trip is the canonical trigger — the
 * recovery hint nudges callers to re-fetch.
 */
export class PlotAttachmentNotFoundError extends WarrenError {
	readonly code = "plot_attachment_not_found";
}

/**
 * Raised by `POST /plots/:id/questions/:event_id/answer` (warren-e1ac /
 * pl-9d6a step 12) when the targeted `:event_id` does not match any
 * `question_posed` event in the Plot's event log. Mapped to 404 in
 * `src/server/errors.ts`.
 *
 * The wire `:event_id` is the ISO timestamp (`at`) of the
 * `question_posed` event the UI is answering — PlotEvent has no
 * synthetic id field, and `at` is the only stable identifier the lib
 * surfaces on the wire. A typo or stale UI state is the canonical
 * trigger; the recovery hint nudges callers to re-fetch the envelope.
 */
export class PlotQuestionNotFoundError extends WarrenError {
	readonly code = "plot_question_not_found";
}

/**
 * Raised by `POST /plots/:id/questions/:event_id/answer` (warren-e1ac /
 * pl-9d6a step 12) when a subsequent `question_answered` event already
 * references the same `question_id` (the targeted `:event_id`). The
 * `@os-eco/plot-cli` library does NOT guarantee single-answer
 * semantics on its own — warren enforces the invariant at the handler
 * edge by walking the event log forward from the targeted question.
 * Mapped to 409 in `src/server/errors.ts` (state-transition shape) so
 * HTTP consumers can branch on `code === "plot_question_already_answered"`.
 */
export class PlotQuestionAlreadyAnsweredError extends WarrenError {
	readonly code = "plot_question_already_answered";
}

/**
 * Raised by `POST /runs` and `POST /plan-runs` (warren-bae5 / pl-5310
 * step 2) when the supplied `plotId` does not match the
 * `^plot-[a-z0-9]+$` shape that `@os-eco/plot-cli` mints. Mapped to
 * 400 in `src/server/errors.ts`. HTTP consumers branch on
 * `code === "plot_id_invalid"`.
 *
 * Origin: dogfood signal #4 from plot-3e72876d (warren-a353). A user
 * pasted the prose form `plot_id=plot-3e72876d` (including the
 * `plot_id=` prefix) into the NewRun plot_id input. The previous
 * silent-accept posture amplified once steps 3 and 4 of pl-5310
 * landed batch + plan-run dispatch on top of the single-run
 * primitive — N runs against a malformed plot_id would silently
 * fail N appender calls. Validating at the dispatch edge keeps the
 * failure local to the operator-facing input.
 */
export class PlotIdInvalidError extends WarrenError {
	readonly code = "plot_id_invalid";
}

/**
 * Raised by `POST /runs` and `POST /plan-runs` (warren-bae5 / pl-5310
 * step 2) when the supplied `plotId` is well-formed but no
 * `hasPlot=true` project owns it (per `PlotResolver.resolve`). Mapped
 * to 400 in `src/server/errors.ts`. HTTP consumers branch on
 * `code === "plot_id_not_found"`.
 *
 * The existence check piggybacks on `PlotResolver` (src/plots/resolver.ts)
 * which is already used by every per-Plot handler. Only fires when
 * the resolver is wired into ServerDeps — production wires it in
 * src/server/main.ts. Test harnesses that don't wire a resolver get
 * format-only validation (matches the existing per-Plot handler
 * posture in handlers.ts).
 */
export class PlotIdNotFoundError extends WarrenError {
	readonly code = "plot_id_not_found";
}

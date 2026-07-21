/**
 * Plot dispatcher-handle sanitization (warren-e848). Extracted from the
 * spawn flow's `plot-append.ts` when the `run_dispatched` Plot append was
 * removed from dispatch (warren-39e3); the handle helpers stay because the
 * Plot HTTP handlers still resolve a caller-supplied actor handle before
 * mutating a Plot's event log.
 */

/**
 * Default user handle used for a Plot event when the caller doesn't supply
 * one. Warren has no first-class user-auth surface today; a fixed fallback
 * keeps the Plot's event log well-formed and matches the `user:<handle>`
 * actor regex.
 */
export const DEFAULT_DISPATCHER_HANDLE = "operator";

/**
 * Actor segment regex copied from `@os-eco/plot-cli`'s actor.ts:
 * `[A-Za-z0-9][A-Za-z0-9_-]*`. A handle that fails this check is downgraded
 * to `DEFAULT_DISPATCHER_HANDLE` rather than throwing.
 */
const ACTOR_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Validate a caller-supplied dispatcher handle against Plot's actor segment
 * regex; downgrade malformed / empty input to `DEFAULT_DISPATCHER_HANDLE`
 * so a Plot event's `user:<handle>` actor is always well-formed.
 */
export function resolveDispatcherHandle(input: string | undefined): string {
	const trimmed = (input ?? "").trim();
	if (trimmed === "") return DEFAULT_DISPATCHER_HANDLE;
	if (!ACTOR_SEGMENT_RE.test(trimmed)) return DEFAULT_DISPATCHER_HANDLE;
	return trimmed;
}

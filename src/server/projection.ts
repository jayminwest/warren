/**
 * Public response projections (warren-946f / pl-b82d step 14).
 *
 * `WARREN_AUTH=public` (warren-851b) admits a credential-less spectator
 * holding `readPublic` and nothing else, and the route policy table
 * (warren-b875) decides which endpoints that actor may reach at all. This
 * module is the second half of that story: *what* a `readPublic`-only
 * caller sees in a body it is allowed to fetch.
 *
 * Two rules the projections built on this module must follow:
 *
 * 1. **Allowlist, never denylist.** `pickFields` can only ever emit keys
 *    that were named up front, so a column added to a table tomorrow is
 *    absent from the public body by construction. A denylist would leak
 *    it on the day it lands — exactly the failure mode pl-b82d exists to
 *    prevent.
 * 2. **One source, two audiences.** A handler builds the operator body
 *    once and hands it to the projector; the public body is that same
 *    value minus fields. The two can't drift because there is only one
 *    construction site.
 *
 * This is response-body redaction and has nothing to do with
 * `src/server/main/redact.ts`, which redacts pino log records.
 */

import type { Actor } from "./types.ts";

/**
 * Does this caller get the public projection rather than the full body?
 *
 * Keyed on the capability, never on `actor.kind` (per `RouteContext.actor`):
 * anything that can't read the operator surface gets the narrowed one. An
 * absent actor means the request never passed the gate — auth-exempt paths
 * and hand-built test contexts — and is treated as the operator, matching
 * the pre-public-mode behavior of every handler.
 */
export function isPublicOnly(actor: Actor | undefined): boolean {
	return actor !== undefined && !actor.capabilities.readOperator;
}

/**
 * Copy exactly `keys` off `source`. The allowlist primitive every public
 * projection is built from — `Pick` at runtime, so the emitted shape and
 * the declared type can't disagree.
 */
export function pickFields<T extends object, K extends keyof T>(
	source: T,
	keys: readonly K[],
): Pick<T, K> {
	const out = {} as Pick<T, K>;
	for (const key of keys) out[key] = source[key];
	return out;
}

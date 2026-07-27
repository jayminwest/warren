// Relative imports, not the `@/` alias — deliberate. This module is
// exercised by the repo-root `bun test` runner, which resolves no `@/`
// (only Vite and `src/ui/tsconfig.app.json` do), so a RUNTIME `@/` import
// here would fail to load the test file. Type-only `@/` imports are fine
// anywhere because `verbatimModuleSyntax` erases them (mx-2e4a1a).
import { UnauthorizedError } from "../api/client.ts";
import type { ActorIdentity, CapabilityName, WhoamiResponse } from "../api/types.ts";

/**
 * - `loading` — the one `/whoami` fetch is in flight. Affordances stay
 *   hidden; a route guard waits rather than bouncing.
 * - `ready` — warren named the caller. `granted` is authoritative.
 * - `unauthenticated` — `/whoami` 401'd. Under the default
 *   `WARREN_AUTH=token` this is what a tokenless browser gets, so it means
 *   "go to the login screen", NOT "you are anonymous" (warren-e195).
 * - `error` — `/whoami` failed for some other reason (network, 5xx). Not a
 *   permission answer, so the UI must not degrade an operator to read-only
 *   over a blip; `AuthGate` surfaces it instead.
 */
export type CapabilityStatus = "loading" | "ready" | "unauthenticated" | "error";

export interface Capabilities {
	status: CapabilityStatus;
	/** Who warren admitted this browser as; null unless `status === "ready"`. */
	identity: ActorIdentity | null;
	/** Granted capability names. Empty unless `status === "ready"`. */
	granted: readonly CapabilityName[];
	/**
	 * Fail-closed membership test: false while loading, on 401, and on
	 * error. An affordance renders only once warren has said yes.
	 */
	can: (capability: CapabilityName) => boolean;
	/** The `/whoami` failure; non-null only when `status === "error"`. */
	error: unknown;
}

/** The slice of a react-query result `resolveCapabilities` reads. */
export interface WhoamiQueryState {
	data: WhoamiResponse | undefined;
	error: unknown;
}

const NO_CAPABILITIES: readonly CapabilityName[] = [];

function denied(status: CapabilityStatus, error: unknown): Capabilities {
	return { status, identity: null, granted: NO_CAPABILITIES, can: () => false, error };
}

/**
 * Map a `/whoami` query result onto the capability state. Pure and total —
 * the whole decision lives here so it is testable without a renderer.
 *
 * Data wins over a stale error: react-query keeps the last error around
 * after a successful refetch, and a browser holding a real answer is not
 * unauthenticated.
 */
export function resolveCapabilities(query: WhoamiQueryState): Capabilities {
	if (query.data !== undefined) {
		const granted = query.data.capabilities;
		return {
			status: "ready",
			identity: query.data.identity,
			granted,
			can: (capability) => granted.includes(capability),
			error: null,
		};
	}
	if (query.error instanceof UnauthorizedError) return denied("unauthenticated", null);
	if (query.error !== null && query.error !== undefined) return denied("error", query.error);
	return denied("loading", null);
}

/**
 * `retry` predicate for the whoami query. A 401 is a final answer —
 * retrying it only stalls the login redirect — but a transient network
 * failure must not lock an operator out of their own mutation affordances,
 * so everything else gets two more attempts.
 */
export function retryWhoami(failureCount: number, error: Error): boolean {
	if (error instanceof UnauthorizedError) return false;
	return failureCount < 2;
}

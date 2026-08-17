/**
 * Errors for the forge seam (`Forge` — see `contract.ts`).
 *
 * The split (forge-contract.md §2.2): SEAM methods return `ForgeResult<T>`
 * and never throw, so this file holds no per-method error classes. What
 * throws is BOOT — an unknown `WARREN_FORGE` selection or a provider
 * construction failure — mirroring the runtime registry's
 * `UnknownRuntimeError`. The `FORGE_ERROR_HTTP_STATUS` table (modeled on
 * `RUNTIME_BACKEND_STATUS_BY_CODE` in `src/runtime/errors.ts`) lets
 * `src/server/errors.ts` render a `ForgeError` into a neutral envelope
 * without importing provider classes.
 */

import { WarrenError } from "../core/errors.ts";
import type { ForgeErrorKind } from "../core/wire.ts";

/**
 * Thrown when `WARREN_FORGE` names a forge the registry doesn't know. The
 * selector fails loudly rather than silently falling back to the default, so
 * a typo can never route a run onto the wrong forge.
 */
export class UnknownForgeError extends WarrenError {
	readonly code = "unknown_forge";
}

/**
 * Thrown at boot when the SELECTED forge's required configuration is
 * missing or malformed (e.g. `WARREN_FORGE=app` without
 * `WARREN_GITHUB_APP_PRIVATE_KEY`). Mirrors the unknown-kind rule: a
 * misconfigured short-lived backend fails loud at boot rather than
 * degrading to anonymous git against a private repo mid-run (§4).
 */
export class ForgeConfigError extends WarrenError {
	readonly code = "forge_config_invalid";
}

/**
 * Provider-neutral HTTP status for a seam-level `ForgeError`, keyed by its
 * `ForgeErrorKind`, so the HTTP layer can render `{code, message, hint}`
 * without an `instanceof` against any provider class. Kinds the domain caused
 * map to 4xx (`no_credential`/`unauthorized` → 401, `forbidden` → 403,
 * `not_found` → 404, `conflict` → 409, `rate_limited` → 429,
 * `push_protected` → 422, `unsupported` → 424 — the request is
 * unsatisfiable by this forge/credential mode, the same code
 * `agent_not_installed` uses); transport-side kinds map to 502, the
 * backend-failure status the runtime table already established.
 */
export const FORGE_ERROR_HTTP_STATUS: Readonly<Record<ForgeErrorKind, number>> = {
	no_credential: 401,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	rate_limited: 429,
	push_protected: 422,
	unsupported: 424,
	network: 502,
	http_error: 502,
};

/**
 * Resolve the HTTP status for a seam-level failure by its `kind`, or
 * `undefined` when the value carries no recognized forge kind. Reads `kind`
 * defensively off an `unknown` so the HTTP renderer never has to narrow a
 * `ForgeError` structurally beyond this one probe.
 */
export function forgeErrorHttpStatusFor(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const { kind } = err as { kind?: unknown };
	if (typeof kind !== "string") return undefined;
	return FORGE_ERROR_HTTP_STATUS[kind as ForgeErrorKind];
}

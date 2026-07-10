/**
 * Errors for the runtime-provider seam (`RuntimeProvider` — see `contract.ts`).
 *
 * Following the warren per-module idiom (cf. `src/burrow-client/errors.ts`,
 * `src/workspace/errors.ts`), the runtime cluster owns its own error classes
 * extending the shared `WarrenError` base so callers can catch by class or
 * switch on `code`, and the CLI/HTTP renderers format them uniformly.
 */

import { WarrenError } from "../core/errors.ts";

/**
 * Thrown by a provider method that is a deliberate stub — the shell exists so
 * the contract compiles and is wired, but the behavior lands in a later step.
 * The message names the method + the plan step that fills it (see
 * `notImplemented()` in `local/provider.ts`).
 */
export class RuntimeNotImplementedError extends WarrenError {
	readonly code = "runtime_not_implemented";
}

/**
 * Thrown when `WARREN_RUNTIME` names a runtime the registry doesn't know. The
 * selector fails loudly rather than silently falling back to the default, so a
 * typo can never route a run onto the wrong backend.
 */
export class UnknownRuntimeError extends WarrenError {
	readonly code = "unknown_runtime";
}

/**
 * Thrown when a provider cannot satisfy a `RunSpec` it was handed — the
 * neutral intent is missing something the backend requires (e.g. LocalProvider
 * needs a host clone path but `hostClonePathHint` was omitted), or the backing
 * client pool has no resolvable worker. Distinct from a transport failure
 * (`BurrowUnreachableError`) or a burrow-side validation error: this fires on
 * warren's side, before the request leaves the process.
 */
export class RuntimeProviderError extends WarrenError {
	readonly code = "runtime_provider_error";
}

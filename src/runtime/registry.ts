/**
 * Runtime-provider registry + the `WARREN_RUNTIME` selector.
 *
 * One place resolves which `RuntimeProvider` (contract in `./contract.ts`) a
 * warren process runs against, exactly once at boot. Today that is always the
 * burrow-backed `LocalProvider`; the `k8s` backend arrives in phase 3 of the
 * K8s migration (design doc / plan pl-829f) and is reserved here so the
 * selector is stable ahead of it.
 *
 * Selection rules (design doc §5 registry/selector semantics):
 *   - `WARREN_RUNTIME` unset (or blank) → `local` (the default backend).
 *   - `local` → burrow-backed `LocalProvider`.
 *   - `k8s`   → recognized but not yet implemented → throws (fail loud).
 *   - anything else → `UnknownRuntimeError` (fail loud — never silently fall
 *     back to the default, so a typo can't route runs onto the wrong backend).
 *
 * Call sites are NOT routed through the provider yet — that wiring is a later
 * step. The natural composition point is `src/server/main/index.ts`
 * (`bootServer`), where the `burrowClientPool` is already built and threaded
 * into `buildServerDeps`; a `resolveRuntimeProvider(env, { burrowClientPool:
 * () => pool })` call there hands the provider onto `ServerDeps` for the domain.
 */

import type { BurrowClientPool } from "../burrow-client/index.ts";
import type { RuntimeProvider } from "./contract.ts";
import { RuntimeNotImplementedError, UnknownRuntimeError } from "./errors.ts";
import { LocalProvider } from "./local/provider.ts";

/** Runtime backends the selector understands. */
export type RuntimeKind = "local" | "k8s";

/** Selector default when `WARREN_RUNTIME` is unset — the self-host backend. */
export const DEFAULT_RUNTIME_KIND: RuntimeKind = "local";

/** Every recognized `WARREN_RUNTIME` value (used for validation + error hints). */
export const RUNTIME_KINDS: readonly RuntimeKind[] = ["local", "k8s"];

/** Minimal env surface the selector reads. */
export type RuntimeEnv = Readonly<Record<string, string | undefined>>;

/**
 * Dependencies every provider the registry can build is threaded. Kept as a
 * single bag so adding the `k8s` backend later doesn't change the selector's
 * signature. The pool is a factory so the registry needn't own a live pool (see
 * `LocalProviderDeps`).
 */
export interface RuntimeProviderDeps {
	readonly burrowClientPool: () => BurrowClientPool;
}

/**
 * Parse + validate the `WARREN_RUNTIME` selector. Blank/unset resolves to the
 * default; an unrecognized value throws `UnknownRuntimeError`.
 */
export function resolveRuntimeKind(env: RuntimeEnv = process.env): RuntimeKind {
	const raw = env.WARREN_RUNTIME?.trim();
	if (raw === undefined || raw === "") {
		return DEFAULT_RUNTIME_KIND;
	}
	if ((RUNTIME_KINDS as readonly string[]).includes(raw)) {
		return raw as RuntimeKind;
	}
	throw new UnknownRuntimeError(`Unknown WARREN_RUNTIME "${raw}"`, {
		recoveryHint: `Set WARREN_RUNTIME to one of: ${RUNTIME_KINDS.join(", ")} (or leave it unset for "${DEFAULT_RUNTIME_KIND}").`,
	});
}

/**
 * Resolve the runtime provider for this process — call ONCE at boot. Selects on
 * `WARREN_RUNTIME` (see module doc) and constructs the chosen backend from
 * `deps`.
 */
export function resolveRuntimeProvider(
	deps: RuntimeProviderDeps,
	env: RuntimeEnv = process.env,
): RuntimeProvider {
	const kind = resolveRuntimeKind(env);
	switch (kind) {
		case "local":
			return new LocalProvider({ burrowClientPool: deps.burrowClientPool });
		case "k8s":
			throw new RuntimeNotImplementedError(
				'WARREN_RUNTIME="k8s" is not implemented until phase 3 of the K8s migration',
				{
					recoveryHint: `Use WARREN_RUNTIME="local" (the default) until the K8sProvider lands. Recognized runtimes: ${RUNTIME_KINDS.join(", ")}.`,
				},
			);
	}
}

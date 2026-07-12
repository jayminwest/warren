/**
 * Runtime-provider registry + the `WARREN_RUNTIME` selector.
 *
 * One place resolves which `RuntimeProvider` (contract in `./contract.ts`) a
 * warren process runs against, exactly once at boot. The default is the
 * burrow-backed `LocalProvider`; the `k8s` backend (`K8sProvider`, pl-829f phase
 * K8S) is opt-in behind `WARREN_RUNTIME=k8s`.
 *
 * Selection rules (design doc §5 registry/selector semantics):
 *   - `WARREN_RUNTIME` unset (or blank) → `local` (the default backend).
 *   - `local` → burrow-backed `LocalProvider`.
 *   - `k8s`   → `K8sProvider` (skeleton at step 14 — the pod-spec builder is real,
 *     the method bodies land in later steps and throw until then).
 *   - anything else → `UnknownRuntimeError` (fail loud — never silently fall
 *     back to the default, so a typo can't route runs onto the wrong backend).
 *
 * Composition point: `src/server/main/index.ts` (`bootServer`) builds the
 * single `burrowClient` and threads a `resolveRuntimeProvider({ burrowClient:
 * () => client })` provider onto `ServerDeps` for the domain.
 */

import type { CoreV1Api } from "@kubernetes/client-node";
import type { BurrowClient } from "../burrow-client/index.ts";
import type { EnvLike } from "../runs/spawn/callback-env.ts";
import type { RuntimeProvider } from "./contract.ts";
import { UnknownRuntimeError } from "./errors.ts";
import { defaultCoreApiFactory, K8sProvider } from "./k8s/provider.ts";
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
 * signature. The client is a factory so the registry needn't own a live client
 * (see `LocalProviderDeps`).
 */
export interface RuntimeProviderDeps {
	readonly burrowClient: () => BurrowClient;
	/**
	 * Server-process env a provider reads to compute its own plumbing (the
	 * LocalProvider's loopback callback URL, §6.3). Optional — providers
	 * default to `process.env`. Kept on the shared bag so the selector's
	 * signature is stable as backends are added.
	 */
	readonly serverEnv?: EnvLike;
	/**
	 * Lazy Kubernetes core API factory the `K8sProvider` drives — only consulted
	 * for `WARREN_RUNTIME=k8s`. Optional so `local` callers (and tests) needn't
	 * supply one; when omitted, `defaultCoreApiFactory()` loads in-cluster /
	 * kubeconfig config lazily. A test injects a fake here to build a
	 * `K8sProvider` without a cluster.
	 */
	readonly k8sCoreApi?: () => CoreV1Api;
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
			return new LocalProvider({
				burrowClient: deps.burrowClient,
				...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
			});
		case "k8s":
			return new K8sProvider({
				coreApi: deps.k8sCoreApi ?? defaultCoreApiFactory(),
				...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
			});
	}
}

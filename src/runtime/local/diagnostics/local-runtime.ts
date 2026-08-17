/**
 * Local-topology diagnostics + the `warren run` backend resolver (warren-11cc).
 *
 * Bucket 8 of the burrow-client eviction routed everything the
 * `RuntimeProvider` can serve (run dispatch via `provider.create`, sandbox
 * health via `provider.status`) through the seam. The burrow daemon itself is
 * gone now (warren-9a26): the spawn path is warren's in-process engine
 * (warren-413d) and the preview-sidecar seam is warren-owned (warren-4bf3), so
 * the socket probes this module used to export died with the daemon. What is
 * left is genuinely local-topology-specific: the `warren doctor` local-runtime
 * check and the `warren run` local-backend resolver (provider +
 * capability-gated preview seam). Neither has a provider-neutral home — they
 * only exist for the LOCAL backend — so they are scoped HERE, under
 * `src/runtime/local/`, out of `src/cli/` and `src/diagnostics/`. Under
 * `WARREN_RUNTIME=k8s` agents run in pods, so callers skip these entirely
 * (mirroring the `/readyz` behavior from warren-c128,
 * `src/server/handlers/diagnostics.ts`).
 */

import type { DiagnosticCheck } from "../../../diagnostics/checks.ts";
import type { RuntimeProvider } from "../../contract.ts";
import { resolveRuntimeProvider } from "../../registry.ts";
import { LocalSidecarRegistry } from "../preview/registry.ts";
import { createLocalSidecarsResolver, type LocalSidecarsResolver } from "../preview/sidecars.ts";
import { LocalRunStore } from "../run-store.ts";

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Env knobs that configured the retired burrow daemon channel. They are dead
 * config under the internalized runtime (warren-9a26) — nothing reads them
 * anymore — so the doctor check surfaces them instead of letting an operator
 * believe they still do something.
 */
const RETIRED_BURROW_ENV_VARS = [
	"WARREN_BURROW_SOCKET",
	"WARREN_BURROW_HOST",
	"WARREN_BURROW_TOKEN",
	"BURROW_API_TOKEN",
	"WARREN_BURROW_NO_AUTH",
] as const;

/**
 * `warren doctor`'s local-runtime check (reworked in warren-9a26 — this used
 * to probe the co-tenanted burrow daemon's socket, and the daemon is gone).
 * The internalized reality: the local topology runs agents through warren's
 * own in-process sandbox engine, so there is nothing to dial. The check
 * reports that and flags any retired burrow env vars still set as dead
 * config. Informational — always `ok: true`; a stale env var must not fail a
 * deployment that is otherwise healthy. When `override` is supplied (tests)
 * it drives that instead and a throw becomes a real failure.
 */
export async function doctorLocalRuntimeCheck(
	env: EnvLike,
	override?: (env: EnvLike) => Promise<void>,
): Promise<DiagnosticCheck> {
	if (override !== undefined) {
		try {
			await override(env);
			return { name: "local_runtime", ok: true };
		} catch (err) {
			return {
				name: "local_runtime",
				ok: false,
				message: err instanceof Error ? err.message : String(err),
			};
		}
	}
	const stale = RETIRED_BURROW_ENV_VARS.filter((name) => {
		const value = env[name];
		return value !== undefined && value !== "";
	});
	const base = "in-process sandbox engine (no co-tenanted burrow daemon)";
	if (stale.length === 0) {
		return { name: "local_runtime", ok: true, message: base };
	}
	return {
		name: "local_runtime",
		ok: true,
		message: `${base}; retired burrow env vars still set (dead config): ${stale.join(", ")}`,
		hint: "remove them from your environment — nothing reads them since the burrow daemon was internalized",
	};
}

/** The `warren run` local backend: a resolved provider plus its capability-gated seams. */
export interface LocalRunBackend {
	readonly runtimeProvider: RuntimeProvider;
	/** Preview sidecar resolver (present iff `capabilities.previewPorts`). */
	readonly previewSidecars?: LocalSidecarsResolver;
	/** Shut the sidecar registry down (idempotent). */
	close(): Promise<void>;
}

/**
 * Resolve the runtime backend for `warren run` (warren-11cc). Mirrors how
 * `bootServer` + `preview-gc-wiring.ts` wire the server: thread
 * `resolveRuntimeProvider` over env (honoring `WARREN_RUNTIME`) and gate the
 * preview sidecar seam on `capabilities.previewPorts`. Under
 * `WARREN_RUNTIME=k8s` `previewPorts` is `false`, so no burrow client is ever
 * constructed and `close()` only shuts the (empty) sidecar registry down.
 */
export function resolveLocalRunBackend(env: EnvLike): LocalRunBackend {
	// warren-413d: no burrow client on the provider ⇒ the in-process engine
	// (the daemon is off the spawn path for `warren run` too). warren-4bf3:
	// the preview-sidecar seam is warren-owned — the shared run store backs
	// the registry's profile lookup, and no burrow client is constructed at
	// all. Under k8s the store + registry stay dark (previewPorts is false).
	const store = new LocalRunStore();
	const sidecarRegistry = new LocalSidecarRegistry({
		profileFor: (sandboxId) => store.getBySandboxId(sandboxId)?.profile ?? null,
	});
	const runtimeProvider = resolveRuntimeProvider(
		{ serverEnv: env, localStore: store, localSidecars: sidecarRegistry },
		env,
	);
	const previewSidecars = runtimeProvider.capabilities.previewPorts
		? createLocalSidecarsResolver(sidecarRegistry)
		: undefined;
	return {
		runtimeProvider,
		...(previewSidecars !== undefined ? { previewSidecars } : {}),
		close: async () => {
			await sidecarRegistry.shutdownAll().catch(() => undefined);
		},
	};
}

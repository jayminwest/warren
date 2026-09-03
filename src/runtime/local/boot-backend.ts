/**
 * Local-topology boot backend (warren-f796). The SINGLE composition point that
 * owns the local runtime's boot-time seams for the SERVER's `local` boot path,
 * so the boot orchestrator (`src/server/main/`) never reaches into the local
 * provider's internals itself.
 *
 * Bucket 9 of the burrow-client eviction removed `ServerDeps.sandboxClient` and
 * stopped `bootServer` from threading a live client through its wiring. The
 * burrow daemon itself is gone now (warren-9a26): the spawn path is warren's
 * in-process engine (warren-413d), the preview-sidecar seam is warren-owned
 * (warren-4bf3), and the `/readyz` socket probe + boot-time startup warning
 * died with the daemon. What is left is genuinely local-topology-specific:
 * the shared run store, the sidecar registry, and the manifest-backed
 * workspace destroyer — re-homed HERE, under `src/runtime/local/`, out of
 * `src/server/main/`, mirroring the CLI's `resolveLocalRunBackend`
 * (`./diagnostics/local-runtime.ts`, warren-11cc).
 *
 * Under `WARREN_RUNTIME=k8s` there is no local sandbox at all (agents run in
 * pods), so boot never constructs this backend — it resolves the `K8sProvider`
 * directly and every seam here stays dark (matching the `/readyz` behavior
 * from warren-c128).
 */

import type { WorkspaceDestroyer } from "../../runs/reap/gc.ts";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type { RuntimeProvider } from "../contract.ts";
import { resolveRuntimeProvider } from "../registry.ts";
import { LocalSidecarRegistry } from "./preview/registry.ts";
import { createLocalSidecarsResolver, type LocalSidecarsResolver } from "./preview/sidecars.ts";
import { LocalRunStore } from "./run-store.ts";
import { createLocalWorkspaceDestroyer } from "./workspace-gc.ts";

/**
 * The `local` server backend: a resolved provider plus its capability-gated
 * seams, and a `close()` for the sidecar registry this backend owns.
 */
export interface LocalBootBackend {
	readonly runtimeProvider: RuntimeProvider;
	/** Preview sidecar resolver (present iff `capabilities.previewPorts`). */
	readonly previewSidecars?: LocalSidecarsResolver;
	/** Stranded-workspace destroyer (present iff `capabilities.workspaceGc`). */
	readonly workspaceDestroyer?: WorkspaceDestroyer;
	/** Shut the sidecar registry down (idempotent). */
	close(): Promise<void>;
}

/**
 * Resolve the `local` server backend (warren-f796). Threads
 * `resolveRuntimeProvider` over env alone and gates the preview-sidecar +
 * workspace-GC seams on the provider's advertised capabilities. The provider
 * is built WITHOUT a burrow client, so it runs the in-process engine — the
 * burrow daemon is off the spawn path (warren-413d) and off the boot path
 * entirely (warren-9a26). The shared run store lets the sidecar registry
 * resolve each sandbox's profile, and the registry rides the provider so
 * `terminate` cascades sidecar teardown (warren-4bf3). The workspace
 * destroyer is the manifest-backed one (`./workspace-gc.ts`).
 *
 * Call this ONLY under `WARREN_RUNTIME=local`; the k8s boot path resolves the
 * `K8sProvider` directly.
 */
export function resolveLocalBootBackend(
	env: EnvLike,
	deps: { onWorkspaceReady?: (runId: string, at: Date) => void } = {},
): LocalBootBackend {
	const store = new LocalRunStore();
	const sidecarRegistry = new LocalSidecarRegistry({
		profileFor: (sandboxId) => store.getBySandboxId(sandboxId)?.profile ?? null,
	});
	const runtimeProvider = resolveRuntimeProvider(
		{
			serverEnv: env,
			localStore: store,
			localSidecars: sidecarRegistry,
			...(deps.onWorkspaceReady !== undefined ? { onWorkspaceReady: deps.onWorkspaceReady } : {}),
		},
		env,
	);
	const caps = runtimeProvider.capabilities;
	return {
		runtimeProvider,
		...(caps.previewPorts ? { previewSidecars: createLocalSidecarsResolver(sidecarRegistry) } : {}),
		...(caps.workspaceGc ? { workspaceDestroyer: createLocalWorkspaceDestroyer(env) } : {}),
		close: async () => {
			await sidecarRegistry.shutdownAll().catch(() => undefined);
		},
	};
}

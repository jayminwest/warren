/**
 * Local-topology boot backend (warren-f796). The SINGLE composition point that
 * owns the co-tenanted burrow client for the SERVER's `local` boot path, so the
 * boot orchestrator (`src/server/main/`) never imports `burrow-client` itself.
 *
 * Bucket 9 of the burrow-client eviction removed `ServerDeps.burrowClient` and
 * stopped `bootServer` from threading a live client through its wiring. What is
 * left is genuinely local-topology-specific: the self-host backend co-tenants a
 * burrow daemon, so under `WARREN_RUNTIME=local` boot needs a burrow client to
 * probe the socket for `/readyz` + the startup warning, and to close on
 * shutdown. The spawn path (warren-413d) and the preview-sidecar seam
 * (warren-4bf3) are both warren-owned now; the daemon's last consumer here is
 * the probe, which warren-9a26 drops with the daemon itself. All of that is
 * re-homed HERE, under `src/runtime/local/`, out of `src/server/main/`,
 * mirroring the CLI's `resolveLocalRunBackend` (`./diagnostics/burrow.ts`,
 * warren-11cc).
 *
 * Under `WARREN_RUNTIME=k8s` there is no burrow at all (agents run in pods), so
 * boot never constructs this backend — it resolves the `K8sProvider` directly
 * and every seam here stays dark (matching the `/readyz` behavior from
 * warren-c128).
 *
 * The return shape is deliberately burrow-free (provider-neutral resolver +
 * destroyer types, a `DiagnosticCheck` probe thunk) so the boot orchestrator
 * consumes it without ever naming a `burrow-client` type.
 */

import { BurrowClient } from "../../burrow-client/index.ts";
import type { DiagnosticCheck } from "../../diagnostics/checks.ts";
import type { WorkspaceDestroyer } from "../../runs/reap/gc.ts";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type { RuntimeProvider } from "../contract.ts";
import { resolveRuntimeProvider } from "../registry.ts";
import { checkBurrowPoolReachable } from "./diagnostics/burrow.ts";
import { LocalSidecarRegistry } from "./preview/registry.ts";
import { createLocalSidecarsResolver, type LocalSidecarsResolver } from "./preview/sidecars.ts";
import { LocalRunStore } from "./run-store.ts";
import { createLocalWorkspaceDestroyer } from "./workspace-gc.ts";

/**
 * The `local` server backend: a resolved provider plus its capability-gated
 * burrow-bound seams, the `/readyz` burrow probe, and a `close()` for the burrow
 * client this backend lazily constructs.
 */
export interface LocalBootBackend {
	readonly runtimeProvider: RuntimeProvider;
	/** Preview sidecar resolver (present iff `capabilities.previewPorts`). */
	readonly previewSidecars?: LocalSidecarsResolver;
	/** Stranded-workspace destroyer (present iff `capabilities.workspaceGc`). */
	readonly workspaceDestroyer?: WorkspaceDestroyer;
	/** Local-topology `/readyz` burrow-socket probe (warren-76c5). */
	probeBurrow(): Promise<DiagnosticCheck>;
	/** Close the burrow client this backend lazily constructed (idempotent). */
	close(): Promise<void>;
}

/**
 * Resolve the `local` server backend (warren-f796). Builds the single burrow
 * client from env LAZILY (preview sidecars + the /readyz probe only — the
 * spawn path is the in-process engine since warren-413d), threads
 * `resolveRuntimeProvider` over env alone, and gates the preview-sidecar +
 * workspace-GC seams on the provider's advertised capabilities — the same
 * wiring `bootServer` did inline before the eviction, now owned here so the
 * boot orchestrator never imports `burrow-client`. The workspace destroyer
 * is the manifest-backed one (`./workspace-gc.ts`) — no burrow call.
 *
 * Call this ONLY under `WARREN_RUNTIME=local`; the k8s boot path resolves the
 * `K8sProvider` directly (no burrow).
 */
export function resolveLocalBootBackend(env: EnvLike): LocalBootBackend {
	let client: BurrowClient | undefined;
	const getClient = (): BurrowClient => {
		if (client === undefined) client = BurrowClient.fromEnv(env);
		return client;
	};
	// warren-413d: the provider is built WITHOUT a burrow client, so it runs
	// the in-process engine — the burrow daemon is off the spawn path.
	// warren-4bf3: the preview-sidecar seam is warren-owned too — the shared
	// run store lets the registry resolve each sandbox's profile, and the
	// registry rides the provider so `terminate` cascades sidecar teardown.
	// The burrow client below backs only the /readyz probe (warren-9a26
	// drops it with the daemon).
	const store = new LocalRunStore();
	const sidecarRegistry = new LocalSidecarRegistry({
		profileFor: (sandboxId) => store.getBySandboxId(sandboxId)?.profile ?? null,
	});
	const runtimeProvider = resolveRuntimeProvider(
		{ serverEnv: env, localStore: store, localSidecars: sidecarRegistry },
		env,
	);
	const caps = runtimeProvider.capabilities;
	return {
		runtimeProvider,
		...(caps.previewPorts ? { previewSidecars: createLocalSidecarsResolver(sidecarRegistry) } : {}),
		...(caps.workspaceGc ? { workspaceDestroyer: createLocalWorkspaceDestroyer(env) } : {}),
		probeBurrow: () => checkBurrowPoolReachable(getClient()),
		close: async () => {
			await sidecarRegistry.shutdownAll().catch(() => undefined);
			if (client !== undefined) await client.close().catch(() => undefined);
		},
	};
}

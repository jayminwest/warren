/**
 * Local-topology boot backend (warren-f796). The SINGLE composition point that
 * owns the co-tenanted burrow client for the SERVER's `local` boot path, so the
 * boot orchestrator (`src/server/main/`) never imports `burrow-client` itself.
 *
 * Bucket 9 of the burrow-client eviction removed `ServerDeps.burrowClient` and
 * stopped `bootServer` from threading a live client through its wiring. What is
 * left is genuinely local-topology-specific: the self-host backend co-tenants a
 * burrow daemon, so under `WARREN_RUNTIME=local` boot needs a burrow client to
 * (a) back the `LocalProvider`, (b) build the capability-gated preview-sidecar +
 * workspace-GC seams, (c) probe the socket for `/readyz` + the startup warning,
 * and (d) close the client on shutdown. All of that is re-homed HERE, under
 * `src/runtime/local/`, out of `src/server/main/`, mirroring the CLI's
 * `resolveLocalRunBackend` (`./diagnostics/burrow.ts`, warren-11cc).
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
import { createLocalSidecarsResolver, type LocalSidecarsResolver } from "./preview/sidecars.ts";
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
 * client from env LAZILY, threads `resolveRuntimeProvider` over it, and gates
 * the preview-sidecar + workspace-GC seams on the provider's advertised
 * capabilities — the same wiring `bootServer` did inline before the eviction,
 * now owned here so the boot orchestrator never imports `burrow-client`.
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
	const runtimeProvider = resolveRuntimeProvider({ burrowClient: getClient }, env);
	const caps = runtimeProvider.capabilities;
	return {
		runtimeProvider,
		...(caps.previewPorts ? { previewSidecars: createLocalSidecarsResolver(getClient()) } : {}),
		...(caps.workspaceGc ? { workspaceDestroyer: createLocalWorkspaceDestroyer(getClient()) } : {}),
		probeBurrow: () => checkBurrowPoolReachable(getClient()),
		close: async () => {
			if (client !== undefined) await client.close().catch(() => undefined);
		},
	};
}

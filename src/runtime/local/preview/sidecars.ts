/**
 * Warren-owned preview sidecar seam for the LocalProvider.
 *
 * Preview environments are a LocalProvider-only capability
 * (`RuntimeCapabilities.previewPorts`). As of warren-4bf3 (plan pl-3007
 * phase 3) the mechanics — spawning `preview.command` as a long-lived
 * sidecar inside the run's sandbox, listing/deleting sidecars on
 * eviction/teardown, and the inbound host-loopback port forward — run
 * through the warren-owned `LocalSidecarRegistry` (`./registry.ts`) on top
 * of the internalized sandbox (`src/sandbox/`). The burrow daemon's
 * `POST /burrows/:id/sidecars` HTTP API is OFF the preview path; this
 * module is the provider-neutral resolver the preview subsystem
 * (`src/preview/`) and the reap preview sub-step (`src/runs/reap/preview.ts`)
 * consume, so those domain modules never name the local backend.
 *
 * The K8s backend reports `previewPorts: false`, so the boot wiring never
 * builds one of these resolvers under `WARREN_RUNTIME=k8s` — the feature stays
 * dark exactly as it does today for a project without preview config.
 */

import type { SidecarClient } from "../../../preview/eviction/index.ts";
import type { PreviewSidecarsClient } from "../../../preview/launch/index.ts";
import type { LocalSidecarRegistry } from "./registry.ts";

/**
 * The full sidecars facade the registry exposes: the launch surface
 * (`PreviewSidecarsClient`: create/logs/delete/get) PLUS the `list` the
 * eviction/teardown sweeps need. A single structural type so ONE resolver
 * satisfies every preview consumer's narrower seam.
 */
export type LocalSidecarsFacade = PreviewSidecarsClient & Pick<SidecarClient, "list">;

/**
 * Resolve the sidecars facade for a run's sandbox. Returns `null` when the
 * sandbox can't be resolved (mirrors the old pool resolver's contract so the
 * eviction/teardown still run their db-side transition and skip the sidecar
 * stop with a warning). The registry resolves profiles off the LocalProvider's
 * run store, so a sandbox unknown to the store (e.g. after a server restart)
 * resolves to `null`.
 */
export type LocalSidecarsResolver = (sandboxId: string) => Promise<LocalSidecarsFacade | null>;

/**
 * Build the warren-owned sidecar resolver over the sidecar registry. The
 * facade methods keep the burrow-era call shape (the sandbox id rides as the
 * first argument / `sandboxId` field) so `src/preview/` and the reap sub-step
 * consume it unchanged.
 */
export function createLocalSidecarsResolver(registry: LocalSidecarRegistry): LocalSidecarsResolver {
	return async (sandboxId: string): Promise<LocalSidecarsFacade | null> => {
		if (!registry.has(sandboxId)) return null;
		return {
			create: (input) =>
				registry
					.create({
						sandboxId: input.sandboxId,
						command: input.command,
						...(input.env !== undefined ? { env: input.env } : {}),
						...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
						...(input.inboundPortForward !== undefined
							? { inboundPortForward: input.inboundPortForward }
							: {}),
					})
					.then((record) => ({ id: record.id, state: record.state })),
			logs: async (id, sidecarId, opts) => registry.logs(id, sidecarId, opts?.tailBytes),
			delete: (id, sidecarId) => registry.delete(id, sidecarId),
			get: async (id, sidecarId) => {
				const record = registry.get(id, sidecarId);
				return { state: record.state, exitCode: record.exitCode };
			},
			list: async (id) => registry.list(id),
		};
	};
}

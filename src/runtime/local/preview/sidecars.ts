/**
 * Burrow-backed preview sidecar seam for the LocalProvider (warren-e24d).
 *
 * Preview environments are a LocalProvider-only capability
 * (`RuntimeCapabilities.previewPorts`). The mechanics — spawning
 * `preview.command` as a long-lived sidecar, listing/deleting sidecars on
 * eviction/teardown — talk to burrow's `http.sidecars` facade, a burrow-only
 * dialect. This module is the single place that coupling lives: it wraps the
 * burrow client into the provider-neutral resolver the preview subsystem
 * (`src/preview/`) and the reap preview sub-step (`src/runs/reap/preview.ts`)
 * consume, so those domain modules no longer import `burrow-client`.
 *
 * The K8s backend reports `previewPorts: false`, so the boot wiring never
 * builds one of these resolvers under `WARREN_RUNTIME=k8s` — the feature stays
 * dark exactly as it does today for a project without preview config.
 */

import type { BurrowClient } from "../../../burrow-client/index.ts";
import type { SidecarClient } from "../../../preview/eviction/index.ts";
import type { PreviewSidecarsClient } from "../../../preview/launch/index.ts";

/**
 * The full sidecars facade the burrow worker exposes: the launch surface
 * (`PreviewSidecarsClient`: create/logs/delete/get) PLUS the `list` the
 * eviction/teardown sweeps need. A single structural type so ONE resolver
 * satisfies every preview consumer's narrower seam.
 */
export type LocalSidecarsFacade = PreviewSidecarsClient & Pick<SidecarClient, "list">;

/**
 * Resolve the sidecars facade for a run's sandbox. Returns `null` when the
 * sandbox can't be resolved (mirrors the old pool resolver's contract so the
 * eviction/teardown still run their db-side transition and skip the sidecar
 * stop with a warning). LocalProvider has exactly one burrow client, so the
 * `sandboxId` is accepted for shape parity but the same client answers every
 * lookup.
 */
export type LocalSidecarsResolver = (sandboxId: string) => Promise<LocalSidecarsFacade | null>;

/**
 * Build the burrow-backed sidecar resolver. Single-local-burrow (warren-76c5):
 * there is exactly one client, so every `sandboxId` resolves to its
 * `http.sidecars` facade.
 */
export function createLocalSidecarsResolver(client: BurrowClient): LocalSidecarsResolver {
	return async (_sandboxId: string): Promise<LocalSidecarsFacade | null> => {
		const facade = client.http.sidecars;
		return {
			create: (input) => facade.create(input),
			logs: (id, sidecarId, opts) => facade.logs(id, sidecarId, opts),
			delete: (id, sidecarId) => facade.delete(id, sidecarId),
			get: (id, sidecarId) => facade.get(id, sidecarId),
			list: (id) => facade.list(id),
		};
	};
}

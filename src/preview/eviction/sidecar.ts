/**
 * Single-client sidecar resolver for the preview eviction worker
 * (warren-d0a9 split of src/preview/eviction.ts; single-local-burrow fold
 * warren-76c5). Returns the local burrow client's `http.sidecars` facade
 * narrowed to the `list` + `delete` surface the worker uses. Multi-worker
 * placement was retired with the K8s migration, so there is exactly one
 * client to resolve.
 */

import type { BurrowClient } from "../../burrow-client/index.ts";
import type { SidecarClient, SidecarResolver } from "./types.ts";

export function createPoolSidecarResolver(client: BurrowClient): SidecarResolver {
	return async (_burrowId: string): Promise<SidecarClient | null> => {
		const facade = client.http.sidecars;
		return {
			list: (id) => facade.list(id),
			delete: (id, scid) => facade.delete(id, scid),
		};
	};
}

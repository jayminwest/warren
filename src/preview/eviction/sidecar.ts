/**
 * Pool-backed sidecar resolver for the preview eviction worker
 * (warren-d0a9 split of src/preview/eviction.ts). Looks up the worker
 * for a `burrowId` and returns its `http.sidecars` facade narrowed to
 * the `list` + `delete` surface the worker actually uses. Returns
 * `null` when the worker can't be resolved (e.g. the burrow row was
 * deleted while the run was still carrying a stale `burrow_id`) so the
 * eviction still runs db-side but the sidecar stop is skipped with a
 * warning at the call site.
 */

import type { BurrowClientPool } from "../../burrow-client/pool.ts";
import type { SidecarClient, SidecarResolver } from "./types.ts";

export function createPoolSidecarResolver(pool: BurrowClientPool): SidecarResolver {
	return async (burrowId: string): Promise<SidecarClient | null> => {
		try {
			const placement = await pool.clientFor({ burrowId });
			const facade = placement.client.http.sidecars;
			return {
				list: (id) => facade.list(id),
				delete: (id, scid) => facade.delete(id, scid),
			};
		} catch {
			return null;
		}
	};
}

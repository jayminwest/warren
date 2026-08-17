/**
 * Shared test helpers for the preview eviction worker tests
 * (warren-d0a9 split of src/preview/eviction.test.ts).
 */

import type { PreviewEvictionConfig, SidecarClient, SidecarResolver } from "./types.ts";

export interface FakeSidecars {
	resolver: SidecarResolver;
	calls: Array<{ sandboxId: string; sidecarId: string }>;
	listings: Map<string, string[]>;
}

export function fakeSidecars(): FakeSidecars {
	const listings = new Map<string, string[]>();
	const calls: Array<{ sandboxId: string; sidecarId: string }> = [];
	const resolver: SidecarResolver = async (_sandboxId): Promise<SidecarClient> => ({
		list: async (id) => (listings.get(id) ?? []).map((sid) => ({ id: sid })),
		delete: async (id, scid) => {
			calls.push({ sandboxId: id, sidecarId: scid });
			const cur = listings.get(id) ?? [];
			listings.set(
				id,
				cur.filter((s) => s !== scid),
			);
		},
	});
	const seededResolver: SidecarResolver = async (sandboxId) => {
		if (!listings.has(sandboxId)) listings.set(sandboxId, [`sc_${sandboxId}`]);
		return resolver(sandboxId);
	};
	return { resolver: seededResolver, calls, listings };
}

export const BASE_CONFIG: PreviewEvictionConfig = {
	idleTtlMs: 30 * 60_000,
	maxLifetimeMs: 8 * 3_600_000,
	maxLive: 20,
	tickMs: 10_000,
	disabled: false,
};

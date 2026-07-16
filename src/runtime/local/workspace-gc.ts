/**
 * Burrow-backed stranded-workspace destroyer for the LocalProvider
 * (warren-e24d).
 *
 * The fallback workspace-GC sweep (`src/runs/reap/gc.ts`) is provider-neutral:
 * it derives stranded sandbox ids from the `runs` table and calls a
 * {@link WorkspaceDestroyer} seam per candidate. This module is the single
 * place the burrow coupling for that destroy lives — it wraps burrow's
 * `DELETE /burrows/:id` (transport-mapped, with 404 → `already-gone`) into the
 * neutral outcome the sweep counts against.
 *
 * The K8s backend reports `workspaceGc: false` (its pod-GC loop reclaims
 * terminal pods + their emptyDir), so the boot wiring never builds one of these
 * under `WARREN_RUNTIME=k8s` and the domain sweep stays dark — it would
 * otherwise issue a burrow-only destroy against a pod name.
 */

import { NotFoundError as BurrowNotFoundError } from "@os-eco/burrow-cli";
import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { WorkspaceDestroyer, WorkspaceDestroyOutcome } from "../../runs/reap/gc.ts";

/**
 * Build the burrow-backed workspace destroyer. `archive: true` mirrors reap's
 * per-run destroy so the ephemeral store is archived+pruned. A burrow 404
 * means the workspace is already gone on burrow's side — reported as
 * `already-gone` so the sweep counts it reclaimed rather than churning on it.
 * Any other transport/API error is reported as `failed` (never thrown) so one
 * bad candidate can't stall the sweep.
 */
export function createLocalWorkspaceDestroyer(client: BurrowClient): WorkspaceDestroyer {
	return async (sandboxId: string): Promise<WorkspaceDestroyOutcome> => {
		try {
			const result = await withTransportMapping(client.config, () =>
				client.http.burrows.destroy(sandboxId, { archive: true }),
			);
			return {
				status: "destroyed",
				archived: result.archived !== null,
				deletedEvents: result.deletedEvents,
				deletedRuns: result.deletedRuns,
			};
		} catch (err) {
			if (err instanceof BurrowNotFoundError) return { status: "already-gone" };
			return { status: "failed", error: err instanceof Error ? err.message : String(err) };
		}
	};
}

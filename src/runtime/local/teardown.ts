/**
 * `LocalProvider.terminate` body (pl-829f step 11, phase CONTRACT). Wraps
 * burrow's `DELETE /burrows/:id` (`http.burrows.destroy`) with `archive: true` —
 * the SAME reap-time teardown call the domain's `runWorkspaceDestroy`
 * (`src/runs/reap/destroy.ts`, and the GC path in `src/runs/reap/gc.ts`) makes
 * today — as the seam's `terminate(handle)`, and re-shapes burrow's
 * `DestroyBurrowResult` onto the seam's `TeardownResult`. The lost-run
 * recovery's burrow-only `destroyBurrowWorkspaceById` was retired in favor of
 * this seam (warren-48b2).
 *
 * `terminate` is deliberately distinct from `cancel`: cancel gracefully stops the
 * *agent*; terminate kills the *sandbox* and archives+prunes its ephemeral store.
 * Design §4: the domain calls `finalize` THEN `terminate`, so by the time this
 * runs the workspace-dependent half of reap is already done — all this owns is
 * the teardown.
 *
 * Faithful to today's reap teardown call-site:
 *   - Target: `handle.sandboxId` (the burrowId), exactly as `runWorkspaceDestroy`
 *     passes `run.burrowId`.
 *   - `archive: true` — the REAP path archives before pruning (`destroy.ts`'s
 *     `defaultDestroyFn` and `gc.ts` both pass `{ archive: true }`). This is
 *     distinct from `create()`'s partial-failure cleanup, which passes
 *     `archive: false` (`src/runs/spawn/rollback.ts`) because a never-started
 *     burrow has nothing worth archiving. terminate is the reap path, so it
 *     archives — verified against the current call-sites, reality matches the
 *     seed.
 *   - Transport: wrapped in `withTransportMapping` so a dead socket surfaces as
 *     `BurrowUnreachableError` (the domain wraps its destroy the same way).
 *     Burrow-side errors (`BurrowError` subclasses, e.g. `NotFoundError` for a
 *     burrow already gone) propagate UNCHANGED. The "idempotent, best-effort"
 *     orchestration the contract describes lives at the DOMAIN call-site today —
 *     `runWorkspaceDestroy` and the lost-run reconciler's teardown each
 *     try/catch and degrade to a `reap.workspace_destroy_failed` event — not
 *     intrinsic to the burrow call; the provider forwards faithfully and lets
 *     the domain keep owning best-effort (step 13).
 *
 * ## burrow `DestroyBurrowResult` → seam `TeardownResult`
 *
 * | seam field        | burrow field              | note                                 |
 * |-------------------|---------------------------|--------------------------------------|
 * | `archived`        | `archived !== null`        | burrow returns the archive record    |
 * |                   |                           | (or `null` when `archive:false`); the|
 * |                   |                           | seam collapses it to a boolean, the  |
 * |                   |                           | same `archived: result.archived !==  |
 * |                   |                           | null` the reap event emits today.    |
 * | `deletedEvents`   | `deletedEvents`            | 1:1                                  |
 * | `deletedMessages` | `deletedMessages`          | 1:1                                  |
 * | `deletedRuns`     | `deletedRuns`              | 1:1                                  |
 */

import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { RunHandle, TeardownResult } from "../contract.ts";

/**
 * Kill the run's burrow sandbox and archive+prune its ephemeral store, returning
 * the pruned-row counts mapped onto the seam's `TeardownResult`. `archive: true`
 * matches the reap path; `handle.sandboxId` is the burrowId to destroy.
 */
export async function terminateLocalRun(
	client: BurrowClient,
	handle: RunHandle,
): Promise<TeardownResult> {
	const result = await withTransportMapping(client.config, () =>
		client.http.burrows.destroy(handle.sandboxId, { archive: true }),
	);
	return {
		archived: result.archived !== null,
		deletedEvents: result.deletedEvents,
		deletedMessages: result.deletedMessages,
		deletedRuns: result.deletedRuns,
	};
}

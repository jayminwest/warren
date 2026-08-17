import type { PreviewState, RunMode } from "../../db/schema.ts";
import type { TeardownResult } from "../../runtime/contract.ts";

/* ----------------------------------------------------------------------- */
/* Workspace destroy (warren-0d89)                                          */
/* ----------------------------------------------------------------------- */

export interface RunWorkspaceDestroyInput {
	readonly run: {
		readonly id: string;
		readonly sandboxId: string | null;
		readonly mode: RunMode;
		readonly previewState: PreviewState | null;
	};
	/**
	 * Terminal state of this reap's `preview_launch` sub-step (null when
	 * skipped/not-opted-in). A `live` launch means the workspace is still
	 * hosting a preview sidecar, so destroy must be deferred to the
	 * eviction worker.
	 */
	readonly previewLaunchState: "live" | "failed" | null;
	/**
	 * warren-495d: the branch push did NOT complete (finalize timed out / the
	 * pod vanished / the push stage failed) AND salvage could not capture the
	 * work either (warren-cd3b — reap's local salvage runs BEFORE this flag is
	 * computed; a successful capture clears it, so the skip now means
	 * "unrecoverable", not merely "unpushed"). Destroy is SKIPPED (without an
	 * error) so the work stays recoverable instead of being silently lost —
	 * the run is already being terminalized `failed`/`finalize_failed`, and
	 * the GC/eviction path can reclaim the workspace later once operators
	 * have recovered the branch. Note the K8s caveat: the skip preserves
	 * nothing by itself there (the pod's emptyDir dies with the container) —
	 * the in-pod salvage (`src/runtime/k8s/salvage.ts`) is the k8s capture.
	 */
	readonly branchPushFailed?: boolean;
	/**
	 * The RuntimeProvider `terminate(handle)` seam bound to this run (warren-1f56)
	 * — reap calls it to tear the sandbox down. `null` when the run has no burrow
	 * or reap never resolved the worker (mirrors the old `workerClient === null`
	 * skip). The domain owns the best-effort try/catch here; the provider
	 * propagates errors.
	 */
	readonly terminate: (() => Promise<TeardownResult>) | null;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly fail: (step: "workspace_destroy", err: unknown) => Promise<void>;
}

/**
 * Final reap sub-step (warren-0d89): destroy the burrow workspace once all
 * data has been extracted and the branch pushed, so workspaces don't
 * accumulate on the persistent volume (the 2026-05-27 disk-full incident).
 * The teardown itself goes through `provider.terminate` (warren-1f56); this
 * function owns the reap-side gating, the `reap.workspace_destroyed` event,
 * and the best-effort try/catch.
 *
 * Skipped — without an error — when:
 *   - the run has no burrow to destroy, or reap never resolved the worker;
 *   - the run is `interactive` (it may respawn into the same workspace);
 *   - a preview is still live (this reap launched one, or an earlier launch
 *     left `previewState` in `starting`/`live`) — the eviction worker owns
 *     teardown in that case;
 *   - the branch push did not complete (`branchPushFailed`, warren-495d) — the
 *     agent's commits are still only on this workspace, so it is preserved for
 *     recovery instead of destroyed.
 *
 * Best-effort like every other reap sub-step: a destroy failure emits
 * `reap_failed` step=`workspace_destroy` and never blocks the run's
 * terminal-state transition. On success a `reap.workspace_destroyed` event is
 * emitted.
 */
export async function runWorkspaceDestroy(input: RunWorkspaceDestroyInput): Promise<boolean> {
	const { run, terminate } = input;
	if (run.sandboxId === null || terminate === null) return false;

	if (input.branchPushFailed === true) {
		await input.emit("reap.workspace_destroy_skipped", {
			sandboxId: run.sandboxId,
			reason: "branch_push_failed",
		});
		return false;
	}

	const previewActive =
		input.previewLaunchState === "live" ||
		run.previewState === "starting" ||
		run.previewState === "live";
	if (previewActive) {
		await input.emit("reap.workspace_destroy_skipped", {
			sandboxId: run.sandboxId,
			reason: "preview_active",
		});
		return false;
	}

	try {
		const result = await terminate();
		await input.emit("reap.workspace_destroyed", {
			sandboxId: run.sandboxId,
			archived: result.archived,
			deletedEvents: result.deletedEvents,
			deletedMessages: result.deletedMessages,
			deletedRuns: result.deletedRuns,
		});
		return true;
	} catch (err) {
		await input.fail("workspace_destroy", err);
		return false;
	}
}

import type { PreviewState, RunMode } from "../../db/schema.ts";
import type { TeardownResult } from "../../runtime/contract.ts";

/* ----------------------------------------------------------------------- */
/* Workspace destroy (warren-0d89)                                          */
/* ----------------------------------------------------------------------- */

export interface RunWorkspaceDestroyInput {
	readonly run: {
		readonly id: string;
		readonly burrowId: string | null;
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
 *   - the run is `interactive` or `conversation` (it may respawn into / keep
 *     streaming against the same workspace; warren-c770);
 *   - a preview is still live (this reap launched one, or an earlier launch
 *     left `previewState` in `starting`/`live`) — the eviction worker owns
 *     teardown in that case.
 *
 * Best-effort like every other reap sub-step: a destroy failure emits
 * `reap_failed` step=`workspace_destroy` and never blocks the run's
 * terminal-state transition. On success a `reap.workspace_destroyed` event is
 * emitted.
 */
export async function runWorkspaceDestroy(input: RunWorkspaceDestroyInput): Promise<boolean> {
	const { run, terminate } = input;
	if (run.burrowId === null || terminate === null) return false;

	// warren-c770: a conversation anchors a still-open pi-chat session whose
	// workspace must survive across turns; destroying it would strand the live
	// transcript.
	if (run.mode === "conversation") {
		await input.emit("reap.workspace_destroy_skipped", {
			burrowId: run.burrowId,
			reason: "conversation_run",
		});
		return false;
	}

	const previewActive =
		input.previewLaunchState === "live" ||
		run.previewState === "starting" ||
		run.previewState === "live";
	if (previewActive) {
		await input.emit("reap.workspace_destroy_skipped", {
			burrowId: run.burrowId,
			reason: "preview_active",
		});
		return false;
	}

	try {
		const result = await terminate();
		await input.emit("reap.workspace_destroyed", {
			burrowId: run.burrowId,
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

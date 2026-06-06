import type { DestroyBurrowResult } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { PreviewState, RunMode } from "../../db/schema.ts";

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
	/** Worker client that owns the burrow; null when reap couldn't resolve it. */
	readonly workerClient: BurrowClient | null;
	readonly repos: { burrows: { delete: (id: string) => Promise<void> } };
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly fail: (step: "workspace_destroy", err: unknown) => Promise<void>;
	/**
	 * Override the burrow destroy seam (tests). Defaults to the live
	 * `client.http.burrows.destroy`.
	 */
	readonly destroyBurrow?: (client: BurrowClient, burrowId: string) => Promise<DestroyBurrowResult>;
}

/**
 * Final reap sub-step (warren-0d89): destroy the burrow workspace once all
 * data has been extracted and the branch pushed, so workspaces don't
 * accumulate on the persistent volume (the 2026-05-27 disk-full incident).
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
 * terminal-state transition. On success the burrows row is removed so
 * `clientFor()` routing won't try to contact a dead workspace, and a
 * `reap.workspace_destroyed` event is emitted.
 */
export async function runWorkspaceDestroy(input: RunWorkspaceDestroyInput): Promise<boolean> {
	const { run, workerClient } = input;
	if (run.burrowId === null || workerClient === null) return false;

	// warren-c770: extend the interactive exemption to `conversation` runs.
	// A conversation anchors a still-open pi-chat session whose workspace must
	// survive across turns; destroying it would strand the live transcript.
	if (run.mode === "interactive" || run.mode === "conversation") {
		await input.emit("reap.workspace_destroy_skipped", {
			burrowId: run.burrowId,
			reason: run.mode === "conversation" ? "conversation_run" : "interactive_run",
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

	const destroyFn =
		input.destroyBurrow ??
		((client: BurrowClient, burrowId: string) =>
			client.http.burrows.destroy(burrowId, { archive: true }));

	try {
		const result = await withTransportMapping(workerClient.config, () =>
			destroyFn(workerClient, run.burrowId as string),
		);
		await input.repos.burrows.delete(run.burrowId);
		await input.emit("reap.workspace_destroyed", {
			burrowId: run.burrowId,
			archived: result.archived !== null,
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

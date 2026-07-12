import type { DestroyBurrowResult } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { PreviewState, RunMode } from "../../db/schema.ts";
import type { TeardownResult } from "../../runtime/contract.ts";

/* ----------------------------------------------------------------------- */
/* Workspace destroy (warren-0d89)                                          */
/* ----------------------------------------------------------------------- */

type DestroyFn = (client: BurrowClient, burrowId: string) => Promise<DestroyBurrowResult>;

const defaultDestroyFn: DestroyFn = (client, burrowId) =>
	client.http.burrows.destroy(burrowId, { archive: true });

/**
 * Shared teardown core: destroy the burrow over its worker transport and emit
 * `reap.workspace_destroyed`. Throws on failure so each caller can map the
 * error onto its own failure channel. (The `burrows` placement table was
 * dropped in warren-3743, so there is no longer a warren-side row to delete —
 * `http.burrows.destroy` tears down the sandbox on burrow's side.)
 */
async function executeBurrowDestroy(args: {
	readonly workerClient: BurrowClient;
	readonly burrowId: string;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly destroyFn: DestroyFn;
}): Promise<void> {
	const result = await withTransportMapping(args.workerClient.config, () =>
		args.destroyFn(args.workerClient, args.burrowId),
	);
	await args.emit("reap.workspace_destroyed", {
		burrowId: args.burrowId,
		archived: result.archived !== null,
		deletedEvents: result.deletedEvents,
		deletedMessages: result.deletedMessages,
		deletedRuns: result.deletedRuns,
	});
}

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

export interface DestroyBurrowWorkspaceByIdInput {
	readonly burrowId: string;
	readonly mode: RunMode;
	/** The single local burrow client (warren-76c5). */
	readonly burrowClient: BurrowClient;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	/** Override the burrow destroy seam (tests). */
	readonly destroyBurrow?: DestroyFn;
}

/**
 * warren-4f01: best-effort burrow-workspace teardown for runs that bypass
 * the normal reap pipeline — e.g. a wedged run finalized
 * `failed`/`burrow_unreachable` by `reconcileLostBurrowRun`. Once such a row
 * goes terminal a later `reapRun` short-circuits via
 * `buildAlreadyTerminalResult` (`workspaceDestroyed:false`), so the burrow's
 * bwrap/pi sandbox would otherwise leak on the host. Destroys the burrow over
 * the local client and emits `reap.workspace_destroyed`. Conversation runs
 * keep their workspace
 * (warren-c770). Every failure degrades to a `reap.workspace_destroy_failed`
 * system event plus `false`; this never throws.
 */
export async function destroyBurrowWorkspaceById(
	input: DestroyBurrowWorkspaceByIdInput,
): Promise<boolean> {
	if (input.mode === "conversation") {
		await input.emit("reap.workspace_destroy_skipped", {
			burrowId: input.burrowId,
			reason: "conversation_run",
		});
		return false;
	}

	const workerClient: BurrowClient = input.burrowClient;

	try {
		await executeBurrowDestroy({
			workerClient,
			burrowId: input.burrowId,
			emit: input.emit,
			destroyFn: input.destroyBurrow ?? defaultDestroyFn,
		});
		return true;
	} catch (err) {
		await input.emit("reap.workspace_destroy_failed", {
			burrowId: input.burrowId,
			step: "destroy",
			message: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

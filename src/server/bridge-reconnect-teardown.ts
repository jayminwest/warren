/**
 * Lost-run sandbox teardown for `reconcileLostBurrowRun` (`./bridge-reconnect.ts`).
 * Extracted to keep that file under the file-size ratchet (warren-a7cb).
 *
 * When the active RuntimeProvider is threaded the teardown routes through
 * `provider.terminate(handle)` so it works for BOTH backends: K8s deletes the
 * pod + seed ConfigMaps, LocalProvider destroys the burrow. Self-host callers
 * that don't thread a provider fall back to the burrow-only
 * `destroyBurrowWorkspaceById`, keeping that path byte-identical.
 */

import type { BurrowClient } from "../burrow-client/index.ts";
import type { RunMode } from "../db/schema.ts";
import type { BoundBridgeLogger } from "../runs/index.ts";
import {
	type DestroyBurrowWorkspaceByIdInput,
	destroyBurrowWorkspaceById,
} from "../runs/reap/destroy.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";

export interface LostRunTeardownInput {
	readonly runId: string;
	readonly burrowRunId: string;
	/** The run's burrow/pod id + mode, resolved by the reconciler. */
	readonly burrow: { readonly id: string; readonly mode: RunMode };
	/** Active backend; when present the teardown routes through `terminate`. */
	readonly runtimeProvider?: RuntimeProvider;
	/** Burrow fallback for the self-host path (no provider threaded). */
	readonly burrowClient?: BurrowClient;
	/** Override the burrow-destroy seam (tests). */
	readonly destroyWorkspace?: (input: DestroyBurrowWorkspaceByIdInput) => Promise<boolean>;
	/** Append + publish a `stream:'system'` event on the run. */
	readonly emit: (kind: string, payload: Record<string, unknown>) => Promise<void>;
	readonly log: BoundBridgeLogger;
}

/**
 * Tear down a lost run's sandbox. Prefers the RuntimeProvider seam
 * (`provider.terminate`) so it works for both backends; falls back to the
 * burrow-only `destroyBurrowWorkspaceById` when no provider is threaded, keeping
 * the self-host path byte-identical. No-op when there's neither a provider nor a
 * burrow client. Best-effort: every failure degrades to an event, never throws.
 */
export async function teardownLostRunWorkspace(input: LostRunTeardownInput): Promise<void> {
	if (input.runtimeProvider !== undefined) {
		await terminateLostWorkspace(input, input.runtimeProvider);
		return;
	}
	if (input.burrowClient === undefined) return;
	const destroy = input.destroyWorkspace ?? destroyBurrowWorkspaceById;
	try {
		await destroy({
			burrowId: input.burrow.id,
			mode: input.burrow.mode,
			burrowClient: input.burrowClient,
			emit: async (kind, payload) => {
				await input.emit(kind, payload as Record<string, unknown>);
			},
		});
	} catch (err) {
		input.log.error(
			{
				event: "bridge.workspace_destroy_failed",
				err: err instanceof Error ? err.message : String(err),
			},
			"reconcileLostBurrowRun: best-effort workspace destroy threw",
		);
	}
}

/**
 * warren-a7cb: lost-run sandbox teardown routed through the RuntimeProvider seam.
 * Mirrors `destroyBurrowWorkspaceById`'s gating + event shapes so the observable
 * surface is identical, but calls `provider.terminate(handle)` — under K8s that
 * deletes the pod + seed ConfigMaps, under LocalProvider it destroys the burrow.
 * Conversation runs keep their workspace (warren-c770). Best-effort: any failure
 * degrades to a `reap.workspace_destroy_failed` event and never throws.
 */
async function terminateLostWorkspace(
	input: LostRunTeardownInput,
	provider: RuntimeProvider,
): Promise<void> {
	const { burrow } = input;
	if (burrow.mode === "conversation") {
		await input.emit("reap.workspace_destroy_skipped", {
			burrowId: burrow.id,
			reason: "conversation_run",
		});
		return;
	}
	const handle: RunHandle = {
		runId: input.runId,
		sandboxId: burrow.id,
		providerRunId: input.burrowRunId,
	};
	try {
		const result = await provider.terminate(handle);
		await input.emit("reap.workspace_destroyed", {
			burrowId: burrow.id,
			archived: result.archived,
			deletedEvents: result.deletedEvents,
			deletedMessages: result.deletedMessages,
			deletedRuns: result.deletedRuns,
		});
	} catch (err) {
		await input.emit("reap.workspace_destroy_failed", {
			burrowId: burrow.id,
			step: "destroy",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

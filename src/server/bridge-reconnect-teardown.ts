/**
 * Lost-run sandbox teardown for `reconcileLostSandboxRun` (`./bridge-reconnect.ts`).
 * Extracted to keep that file under the file-size ratchet (warren-a7cb).
 *
 * The teardown routes exclusively through the RuntimeProvider seam
 * (`provider.terminate(handle)`) so it works for BOTH backends: K8s deletes the
 * pod + seed ConfigMaps, LocalProvider destroys the burrow (the burrow destroy
 * lives in `LocalProvider.terminate`, byte-identical to the retired
 * `destroyBurrowWorkspaceById`). The reconciler always threads the boot-resolved
 * backend (warren-5a3f), so there is no burrow-only fallback and nothing here
 * speaks the burrow dialect.
 */

import type { RunMode } from "../db/schema.ts";
import type { BoundBridgeLogger } from "../runs/index.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";

export interface LostRunTeardownInput {
	readonly runId: string;
	readonly sandboxRunId: string;
	/** The run's burrow/pod id + mode, resolved by the reconciler. */
	readonly sandbox: { readonly id: string; readonly mode: RunMode };
	/** Active backend the teardown routes `provider.terminate()` through. */
	readonly runtimeProvider: RuntimeProvider;
	/** Append + publish a `stream:'system'` event on the run. */
	readonly emit: (kind: string, payload: Record<string, unknown>) => Promise<void>;
	readonly log: BoundBridgeLogger;
}

/**
 * Tear down a lost run's sandbox through the RuntimeProvider seam
 * (`provider.terminate`) so both backends are covered (K8s pod delete / burrow
 * destroy) — the boot-resolved backend is always threaded (warren-5a3f), so
 * nothing outside `LocalProvider` speaks the burrow dialect. Best-effort: every
 * failure degrades to a `reap.workspace_destroy_failed` event, never throws.
 */
export async function teardownLostRunWorkspace(input: LostRunTeardownInput): Promise<void> {
	await terminateLostWorkspace(input, input.runtimeProvider);
}

/**
 * warren-a7cb: lost-run sandbox teardown routed through the RuntimeProvider seam.
 * Mirrors `destroyBurrowWorkspaceById`'s gating + event shapes so the observable
 * surface is identical, but calls `provider.terminate(handle)` — under K8s that
 * deletes the pod + seed ConfigMaps, under LocalProvider it destroys the burrow.
 * Best-effort: any failure degrades to a `reap.workspace_destroy_failed` event
 * and never throws.
 */
async function terminateLostWorkspace(
	input: LostRunTeardownInput,
	provider: RuntimeProvider,
): Promise<void> {
	const { sandbox } = input;
	const handle: RunHandle = {
		runId: input.runId,
		sandboxId: sandbox.id,
		providerRunId: input.sandboxRunId,
	};
	try {
		const result = await provider.terminate(handle);
		await input.emit("reap.workspace_destroyed", {
			sandboxId: sandbox.id,
			archived: result.archived,
			deletedEvents: result.deletedEvents,
			deletedMessages: result.deletedMessages,
			deletedRuns: result.deletedRuns,
		});
	} catch (err) {
		await input.emit("reap.workspace_destroy_failed", {
			sandboxId: sandbox.id,
			step: "destroy",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

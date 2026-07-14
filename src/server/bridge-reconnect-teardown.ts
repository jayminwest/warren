/**
 * Lost-run sandbox teardown for `reconcileLostBurrowRun` (`./bridge-reconnect.ts`).
 * Extracted to keep that file under the file-size ratchet (warren-a7cb).
 *
 * The teardown routes exclusively through the RuntimeProvider seam
 * (`provider.terminate(handle)`) so it works for BOTH backends: K8s deletes the
 * pod + seed ConfigMaps, LocalProvider destroys the burrow (the burrow destroy
 * lives in `LocalProvider.terminate`, byte-identical to the retired
 * `destroyBurrowWorkspaceById`). The reconciler always resolves a provider —
 * either the threaded backend or a `LocalProvider` over its burrow client via
 * `resolveRuntimeProvider` (warren-aa4a / warren-48b2) — so there is no longer a
 * burrow-only fallback. No-op when the reconciler couldn't resolve one.
 */

import type { BurrowClient } from "../burrow-client/index.ts";
import type { RunMode } from "../db/schema.ts";
import type { BoundBridgeLogger } from "../runs/index.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";
import { resolveRuntimeProvider } from "../runtime/registry.ts";

export interface LostRunTeardownInput {
	readonly runId: string;
	readonly burrowRunId: string;
	/** The run's burrow/pod id + mode, resolved by the reconciler. */
	readonly burrow: { readonly id: string; readonly mode: RunMode };
	/** Active backend; when present the teardown routes through it directly. */
	readonly runtimeProvider?: RuntimeProvider;
	/**
	 * Burrow client for the self-host path: absent a threaded provider, a
	 * `LocalProvider` is resolved over it via `resolveRuntimeProvider`
	 * (warren-48b2) so the teardown still runs through the seam.
	 */
	readonly burrowClient?: BurrowClient;
	/** Append + publish a `stream:'system'` event on the run. */
	readonly emit: (kind: string, payload: Record<string, unknown>) => Promise<void>;
	readonly log: BoundBridgeLogger;
}

/**
 * Tear down a lost run's sandbox through the RuntimeProvider seam
 * (`provider.terminate`) so both backends are covered (K8s pod delete / burrow
 * destroy). Uses the threaded backend, else resolves a `LocalProvider` over the
 * burrow client (honoring `WARREN_RUNTIME`) so nothing outside `LocalProvider`
 * speaks the burrow dialect (warren-48b2). No-op when neither is supplied.
 * Best-effort: every failure degrades to a `reap.workspace_destroy_failed`
 * event, never throws.
 */
export async function teardownLostRunWorkspace(input: LostRunTeardownInput): Promise<void> {
	const burrowClient = input.burrowClient;
	const provider =
		input.runtimeProvider ??
		(burrowClient !== undefined
			? resolveRuntimeProvider({ burrowClient: () => burrowClient })
			: undefined);
	if (provider === undefined) return;
	await terminateLostWorkspace(input, provider);
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

/**
 * Setup pre-step for the preview launch flow (warren-d9e7, extracted in
 * warren-62a7 / pl-9088 step 9). Spawns `previewConfig.setup` as its own
 * sidecar (no inbound port forward), polls for terminal state, then
 * returns ok / setup_failed / setup_timeout. Helpers are shared with
 * `./orchestrate.ts` via `./helpers.ts`.
 */

import { captureFailureTail, headTruncate, safeDeleteSidecar } from "./helpers.ts";
import { type LaunchPreviewInput, PREVIEW_FAILURE_TAIL_BYTES } from "./types.ts";

interface SetupStepFailure {
	readonly ok: false;
	readonly reason: "setup_failed" | "setup_timeout";
	readonly message: string;
	readonly failureTail: string;
}

export type SetupStepResult = { readonly ok: true } | SetupStepFailure;

export async function runSetupStep(args: {
	input: LaunchPreviewInput;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	setupCommand: string;
	setupTimeoutMs: number;
	setupPollMs: number;
}): Promise<SetupStepResult> {
	const { input, now, sleep, setupCommand, setupTimeoutMs, setupPollMs } = args;
	let setupSidecarId: string;
	try {
		const created = await input.sidecars.create({
			burrowId: input.burrowId,
			command: ["sh", "-c", setupCommand],
		});
		setupSidecarId = created.id;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			reason: "setup_failed",
			message: `setup spawn failed: ${headTruncate(message, PREVIEW_FAILURE_TAIL_BYTES)}`,
			failureTail: "",
		};
	}

	const deadline = now().getTime() + setupTimeoutMs;
	while (true) {
		let status: { state: string; exitCode: number | null };
		try {
			status = await input.sidecars.get(input.burrowId, setupSidecarId);
		} catch {
			// Transient status-poll failure: don't fail the setup over a single
			// dropped query. Sleep and try again until the wall clock catches up.
			if (now().getTime() >= deadline) {
				const failureTail = await captureFailureTail(
					input.sidecars,
					input.burrowId,
					setupSidecarId,
				);
				await safeDeleteSidecar(input.sidecars, input.burrowId, setupSidecarId);
				return {
					ok: false,
					reason: "setup_timeout",
					message: `setup did not exit within ${setupTimeoutMs}ms`,
					failureTail,
				};
			}
			await sleep(setupPollMs);
			continue;
		}

		if (status.state === "exited") {
			if (status.exitCode === 0) {
				// Best-effort cleanup of the completed setup sidecar — burrow's
				// registry would garbage-collect it eventually, but explicit
				// removal keeps `GET /burrows/:id/sidecars` lists short.
				await safeDeleteSidecar(input.sidecars, input.burrowId, setupSidecarId);
				return { ok: true };
			}
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, setupSidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, setupSidecarId);
			return {
				ok: false,
				reason: "setup_failed",
				message: `setup exited with code ${status.exitCode}`,
				failureTail,
			};
		}

		if (now().getTime() >= deadline) {
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, setupSidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, setupSidecarId);
			return {
				ok: false,
				reason: "setup_timeout",
				message: `setup did not exit within ${setupTimeoutMs}ms`,
				failureTail,
			};
		}
		await sleep(setupPollMs);
	}
}

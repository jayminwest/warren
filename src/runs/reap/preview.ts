import type { BurrowClient } from "../../burrow-client/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { EventRow } from "../../db/schema.ts";
import { parseDurationMs } from "../../preview/duration.ts";
import {
	formatPreviewUrl,
	type LaunchPreviewInput,
	type LaunchPreviewResult,
	launchPreview,
	type PreviewLaunchConfig,
} from "../../preview/launch.ts";
import type { PreviewPortAllocator } from "../../preview/port-allocator.ts";
import { DEFAULT_PREVIEW_MODE, type ServerPreviewConfig } from "../../warren-config/index.ts";
import type { AutoOpenPrConfig } from "../pr.ts";
import {
	type AnnotatePrPreviewInput,
	type AnnotatePrPreviewResult,
	annotatePrPreview,
} from "../pr-annotate.ts";
import type { ReapStep } from "./types.ts";

export interface RunPreviewLaunchInput {
	readonly runId: string;
	readonly burrowId: string;
	readonly workerId: string | null;
	readonly outcome: string;
	readonly previewConfig: ServerPreviewConfig;
	readonly portAllocator: PreviewPortAllocator;
	readonly workerClient: BurrowClient;
	readonly repos: Repos;
	readonly now: () => Date;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>;
	readonly launchPreviewFn?: (input: LaunchPreviewInput) => Promise<LaunchPreviewResult>;
}

export interface RunPreviewLaunchResult {
	readonly state: "live" | "failed" | null;
	readonly port: number | null;
}

/**
 * Preview launch sub-step (R-19 / SPEC §11.L, warren-f156). Extracted from
 * reapRun so the orchestrator stays readable. Returns the lifecycle state
 * and port to surface on the run row; emits `preview_launched` /
 * `reap_failed` events and persists `preview_state=failed` for the
 * cross-host deferral path.
 */
export async function runPreviewLaunch(
	input: RunPreviewLaunchInput,
): Promise<RunPreviewLaunchResult> {
	if (input.workerId !== null && input.workerId !== "local") {
		const message = `preview launch skipped: cross-host preview routing deferred to R-12 (run.worker_id='${input.workerId}')`;
		await input.fail("preview_launch", new Error(message));
		await input.repos.runs.attachPreview(input.runId, {
			previewState: "failed",
			previewFailureMessage: message,
		});
		return { state: "failed", port: null };
	}
	try {
		// warren-0928: per-project override of the readiness probe wall clock.
		// The schema validated shape + bounds at load time, so parseDurationMs
		// is infallible here.
		const readinessTimeoutMs =
			input.previewConfig.readiness_timeout !== undefined
				? parseDurationMs(input.previewConfig.readiness_timeout)
				: undefined;
		// warren-d9e7: same plumb-through for the setup pre-step.
		const setupTimeoutMs =
			input.previewConfig.setup_timeout !== undefined
				? parseDurationMs(input.previewConfig.setup_timeout)
				: undefined;
		// warren-9b15: same plumb-through for the phase-1 connect budget.
		const connectTimeoutMs =
			input.previewConfig.connect_timeout !== undefined
				? parseDurationMs(input.previewConfig.connect_timeout)
				: undefined;
		const result = await (input.launchPreviewFn ?? launchPreview)({
			runId: input.runId,
			burrowId: input.burrowId,
			previewConfig: input.previewConfig,
			repos: input.repos,
			allocator: input.portAllocator,
			sidecars: input.workerClient.http.sidecars,
			now: input.now,
			...(readinessTimeoutMs !== undefined ? { readinessTimeoutMs } : {}),
			...(setupTimeoutMs !== undefined ? { setupTimeoutMs } : {}),
			...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
		});
		if (result.ok) {
			await input.emit("preview_launched", {
				port: result.port,
				sidecarId: result.sidecarId,
			});
			return { state: "live", port: result.port };
		}
		await input.fail("preview_launch", new Error(`${result.reason}: ${result.message}`));
		return { state: "failed", port: result.port };
	} catch (err) {
		await input.fail("preview_launch", err);
		return { state: "failed", port: null };
	}
}

export interface RunPreviewAnnotateInput {
	readonly runId: string;
	readonly prUrl: string;
	readonly previewLaunchState: "live" | "failed";
	readonly autoOpenPr: AutoOpenPrConfig;
	readonly previewLaunchConfig: PreviewLaunchConfig | undefined;
	readonly repos: Repos;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>;
	readonly annotatePrPreviewFn?: (
		input: AnnotatePrPreviewInput,
	) => Promise<AnnotatePrPreviewResult>;
}

/**
 * PR-annotate preview sub-step. Returns the `previewUrl` patched into the
 * PR body when annotation succeeded (live state with host configured),
 * otherwise `null`.
 */
export async function runPreviewAnnotate(input: RunPreviewAnnotateInput): Promise<string | null> {
	const previewHost = input.previewLaunchConfig?.host ?? null;
	const previewMode = input.previewLaunchConfig?.mode ?? DEFAULT_PREVIEW_MODE;
	let previewUrl: string | null = null;
	try {
		if (input.previewLaunchState === "live" && previewHost === null) {
			await input.fail(
				"pr_annotate_preview",
				new Error(
					"WARREN_PREVIEW_HOST unset; cannot patch preview URL into PR (launch state stays live)",
				),
			);
			return null;
		}
		const failureTail =
			input.previewLaunchState === "failed"
				? ((await input.repos.runs.require(input.runId)).previewFailureMessage ?? "")
				: "";
		const result = await (input.annotatePrPreviewFn ?? annotatePrPreview)({
			prUrl: input.prUrl,
			token: input.autoOpenPr.token,
			preview:
				input.previewLaunchState === "live"
					? {
							state: "live",
							url: formatPreviewUrl(input.runId, previewHost as string, previewMode),
						}
					: { state: "failed", failureTail },
		});
		if (result.ok) {
			if (input.previewLaunchState === "live") {
				previewUrl = formatPreviewUrl(input.runId, previewHost as string, previewMode);
			}
			await input.emit("preview_annotated", {
				prUrl: input.prUrl,
				previewUrl,
				mode: result.mode,
				state: input.previewLaunchState,
			});
			return previewUrl;
		}
		await input.fail("pr_annotate_preview", new Error(`${result.reason}: ${result.message}`));
		return null;
	} catch (err) {
		await input.fail("pr_annotate_preview", err);
		return null;
	}
}

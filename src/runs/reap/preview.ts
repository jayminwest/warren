import type { Repos } from "../../db/repos/index.ts";
import type { EventRow } from "../../db/schema.ts";
import type { Forge, PullRequestRef, RepoRef } from "../../forge/contract.ts";
import { parseDurationMs } from "../../preview/duration.ts";
import {
	formatPreviewUrl,
	type LaunchPreviewInput,
	type LaunchPreviewResult,
	launchPreview,
	type PreviewLaunchConfig,
	type PreviewSidecarsClient,
} from "../../preview/launch/index.ts";
import type { PreviewPortAllocator } from "../../preview/port-allocator.ts";
import { DEFAULT_PREVIEW_MODE, type ServerPreviewConfig } from "../../warren-config/index.ts";
import { composePreviewBody, type PreviewAnnotationState } from "../pr-annotate.ts";
import type { ReapStep } from "./types.ts";

export interface RunPreviewLaunchInput {
	readonly runId: string;
	readonly sandboxId: string;
	readonly workerId: string | null;
	readonly outcome: string;
	readonly previewConfig: ServerPreviewConfig;
	readonly portAllocator: PreviewPortAllocator;
	/**
	 * Provider-neutral sidecars facade for the run's sandbox (warren-e24d).
	 * Resolved from the runtime provider's preview seam
	 * (`createLocalSidecarsResolver`); the reap core no longer imports a
	 * burrow dialect type.
	 */
	readonly sidecars: PreviewSidecarsClient;
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
 * Preview launch sub-step (R-19 / docs/design/preview-environments.md, warren-f156). Extracted from
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
			sandboxId: input.sandboxId,
			previewConfig: input.previewConfig,
			repos: input.repos,
			allocator: input.portAllocator,
			sidecars: input.sidecars,
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
	/** The PR `pr_open` just opened — URL for events, refs for the forge call. */
	readonly prUrl: string;
	readonly repoRef: RepoRef;
	readonly prRef: PullRequestRef;
	/**
	 * The PR body `pr_open` composed in this same reap. The Forge contract has
	 * no body read (forge-contract.md §3), so annotation composes the next body
	 * from THIS text rather than a GET.
	 */
	readonly prBody: string;
	readonly previewLaunchState: "live" | "failed";
	/** The boot-resolved forge (warren-45e6). */
	readonly forge: Forge;
	readonly previewLaunchConfig: PreviewLaunchConfig | undefined;
	readonly repos: Repos;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>;
}

/**
 * PR-annotate preview sub-step (warren-45e6: on the Forge seam). Composes
 * the next body in the domain (`composePreviewBody`) and transports it via
 * `forge.setPullRequestBody`. Returns the `previewUrl` patched into the PR
 * body when annotation succeeded (live state with host configured),
 * otherwise `null`.
 *
 * Capability degradation (forge-contract.md §5): a forge without
 * `pullRequestBodyEdit` cannot PATCH a body, so the sub-step REPORTS the
 * skip (`reap.pr_annotate_preview_skipped`) and reap continues — the
 * pre-migration path was silent, which made a missing capability
 * indistinguishable from a non-opted-in project.
 */
export async function runPreviewAnnotate(input: RunPreviewAnnotateInput): Promise<string | null> {
	const previewHost = input.previewLaunchConfig?.host ?? null;
	const previewMode = input.previewLaunchConfig?.mode ?? DEFAULT_PREVIEW_MODE;
	// warren-3f8a: path-mode previews live on the dedicated listener's port.
	const previewPort = input.previewLaunchConfig?.port ?? null;
	let previewUrl: string | null = null;
	try {
		if (!input.forge.capabilities.pullRequestBodyEdit) {
			await input.emit("reap.pr_annotate_preview_skipped", {
				reason: "forge_capability",
				capability: "pullRequestBodyEdit",
				prUrl: input.prUrl,
				state: input.previewLaunchState,
			});
			return null;
		}
		if (input.previewLaunchState === "live" && previewHost === null) {
			await input.fail(
				"pr_annotate_preview",
				new Error(
					"WARREN_PREVIEW_HOST unset; cannot patch preview URL into PR (launch state stays live)",
				),
			);
			return null;
		}
		const preview: PreviewAnnotationState =
			input.previewLaunchState === "live"
				? {
						state: "live",
						url: formatPreviewUrl(input.runId, previewHost as string, previewMode, previewPort),
					}
				: {
						state: "failed",
						failureTail: (await input.repos.runs.require(input.runId)).previewFailureMessage ?? "",
					};
		const edit = composePreviewBody(input.prBody, preview);
		if (input.previewLaunchState === "live") {
			previewUrl = formatPreviewUrl(input.runId, previewHost as string, previewMode, previewPort);
		}
		if (edit.changed) {
			const patched = await input.forge.setPullRequestBody(input.repoRef, input.prRef, edit.body);
			if (!patched.ok) {
				await input.fail(
					"pr_annotate_preview",
					new Error(`${patched.error.kind}: ${patched.error.detail}`),
				);
				return null;
			}
		}
		await input.emit("preview_annotated", {
			prUrl: input.prUrl,
			previewUrl,
			mode: edit.changed ? "patched" : "unchanged",
			state: input.previewLaunchState,
		});
		return previewUrl;
	} catch (err) {
		await input.fail("pr_annotate_preview", err);
		return null;
	}
}

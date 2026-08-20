/**
 * The reap "success pipeline" (warren-c65d): the long sequence of best-effort
 * sub-steps that runs once a non-`queued` run with a live workspace and a
 * surviving project clone reaches reap. Extracted from `run.ts` to keep the
 * top-level `reapRun` orchestrator under budget.
 *
 * ## Routed through the RuntimeProvider seam (warren-1f56, pl-829f step 13)
 *
 * The workspace-touching half — the four tracker merges, the two
 * `chore(warren): seeds state` commit, the branch push, and the
 * commits-ahead + dirtiness probe — runs inside a SINGLE
 * `provider.finalize(handle, intent)` call (§4). finalize returns the mirror
 * deltas, collected events, the `dirty` flag + dirty paths, and the workspace
 * `.seeds/plans.jsonl` snapshot; the domain re-emits those events, classifies
 * `reap.empty_push`, and keeps the interleaved DOMAIN steps at the call-site
 * (baseline snapshot, `sd close`, auto-plan-run detection, PR/preview). The
 * pipeline mutates a {@link ReapPipelineState} accumulator in place so `reapRun`
 * reads the same field set in its terminal `reap.completed` emit.
 */

import { join } from "node:path";
import type { EventRow, ProjectRow, RunRow } from "../../db/schema.ts";
import type { PreviewSidecarResolver } from "../../preview/launch/index.ts";
import type { FinalizeResult, FinalizeStage, RuntimeProvider } from "../../runtime/contract.ts";
import { finalizeCommitStage, finalizeMergeStage } from "../../runtime/contract.ts";
import { PUSH_REJECTED_EVENT } from "../../runtime/push-rejection.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";
import { dispatchAutoPlanRuns, hasAutoPlanRunFrontmatter, parsePlanIds } from "./auto-plan-run.ts";
import { applyK8sCloneDeltas } from "./clone-apply.ts";
import { runProviderFinalize } from "./finalize-intent.ts";
import { type DiffStats, recordOutcomeFacts } from "./outcome-facts.ts";
import { type OpenedPr, runPrOpen } from "./pr-open.ts";
import { runPreviewAnnotate, runPreviewLaunch } from "./preview.ts";
import type { ReapExec, ReapFs, ReapRunInput, ReapStep } from "./types.ts";
import { classifyEmptyPush } from "./util.ts";

/** Mutable accumulator carrying every result the pipeline can produce. */
export interface ReapPipelineState {
	mulchUpdated: number;
	mulchSkipped: number;
	mulchAppended: number;
	seedsClosed: number;
	seedsCreated: number;
	seedsCommitted: boolean;
	branchPushed: boolean;
	commitsAhead: number | null;
	/** warren-ab2b: parsed `git diff --numstat` totals measured at reap;
	 * null = unmeasurable (unknown). Persisted on the run row with commitsAhead. */
	diffStats: DiffStats | null;
	droppedCommit: boolean;
	/** warren-89b0: deliberate no-op (clean/bookkeeping-only tree); stays succeeded. */
	noChanges: boolean;
	/** warren-495d: requested push did NOT complete; fail run + preserve workspace. */
	finalizeFailed: boolean;
	/**
	 * warren-5ea1: set when the finalize result was warren-SYNTHESIZED because
	 * the pod never posted one (the `FinalizeResult.unposted` cause); null on a
	 * pod-computed result. Splits the `finalize_unposted` failure reason from
	 * `finalize_failed` in reap.
	 */
	finalizeUnposted: NonNullable<FinalizeResult["unposted"]> | null;
	/** warren-b68d: the REMOTE refused the push on policy grounds, narrowing
	 * `finalizeFailed` to `push_rejected_policy`. False for a non-fast-forward,
	 * which stays `finalize_failed`; the unblock URL rides the replayed event. */
	pushRejectedByPolicy: boolean;
	/** warren-e9e1 (leg 2): K8s finalize's mirror deltas applied to the clone; local=false. */
	cloneDeltasApplied: boolean;
	/**
	 * warren-486c: the K8s mirror commit could NOT be made durable on origin
	 * (push failed/rejected), so auto-dispatch is suppressed — a plan-run must
	 * never be created against host-only tracker state pods can't clone.
	 */
	mirrorDurabilityFailed: boolean;
	prUrl: string | null;
	/** The full PR handle from `pr_open` — feeds `pr_annotate_preview` (warren-45e6). */
	openedPr: OpenedPr | null;
	previewLaunchState: "live" | "failed" | null;
	previewLaunchPort: number | null;
	previewUrl: string | null;
	autoPlanRunCreated: boolean;
	autoPlanRunId: string | null;
	autoPlanRunPlanId: string | null;
}

/** Fresh state with every field at its "nothing happened yet" default. */
export function createPipelineState(): ReapPipelineState {
	return {
		mulchUpdated: 0,
		mulchSkipped: 0,
		mulchAppended: 0,
		seedsClosed: 0,
		seedsCreated: 0,
		seedsCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		diffStats: null,
		droppedCommit: false,
		noChanges: false,
		finalizeFailed: false,
		finalizeUnposted: null,
		pushRejectedByPolicy: false,
		cloneDeltasApplied: false,
		mirrorDurabilityFailed: false,
		prUrl: null,
		openedPr: null,
		previewLaunchState: null,
		previewLaunchPort: null,
		previewUrl: null,
		autoPlanRunCreated: false,
		autoPlanRunId: null,
		autoPlanRunPlanId: null,
	};
}

/** Context the pipeline needs, resolved by `reapRun` before dispatch. */
export interface ReapPipelineContext {
	readonly input: ReapRunInput;
	readonly run: RunRow;
	/** Non-null in this branch: the project clone survived. */
	readonly project: ProjectRow;
	/** HOST workspace path (LocalProvider) or `null` under K8s — finalize runs
	 * in-pod, the domain applies mirror deltas to the clone (warren-e9e1). */
	readonly workspacePath: string | null;
	readonly branch: string | null;
	readonly baseBranch: string | null;
	/** Preview sidecar seam (warren-e24d); absent when the backend lacks preview
	 * ports (K8s) or no caller wired it. Launch gates on `previewPorts` + this. */
	readonly previewSidecars?: PreviewSidecarResolver;
	/** The RuntimeProvider the workspace-dependent half of reap routes through. */
	readonly provider: RuntimeProvider;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly now: () => Date;
	readonly log: BoundBridgeLogger;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>;
	/**
	 * Record a best-effort failure into reap's `errors[]` WITHOUT emitting a
	 * `reap_failed` event — folds finalize's failed stages into the error trail
	 * when the matching event already rode `FinalizeResult.events`.
	 */
	readonly recordError: (step: ReapStep, message: string) => void;
}

/**
 * warren-357c: map a finalize stage onto reap's step vocabulary. Stage names
 * are DERIVED from the opaque artifact keys (`${key}_merge` / `${key}_commit`),
 * so the fold is a function, not a fixed record. Unknown derived keys and
 * `commits_ahead` fold to nothing — a rev-list failure is log-only, not an error.
 */
function finalizeStageToReapStep(stage: FinalizeStage): ReapStep | undefined {
	switch (stage) {
		case "seed_reset":
			return "seed_reset";
		case "branch_push":
			return "branch_push";
		case finalizeMergeStage("mulch"):
			return "mulch_merge";
		case finalizeMergeStage("seeds"):
			return "seeds_close";
		case finalizeMergeStage("plans"):
			return "plans_mirror";
		case finalizeCommitStage("seeds"):
			return "seeds_commit";
		default:
			return undefined;
	}
}

/**
 * warren-a32a: snapshot the project-clone baseline plans.jsonl BEFORE finalize's
 * plans mirror so auto_plan_run can diff workspace vs baseline — the mirror
 * appends workspace plans into the clone, which would otherwise defeat the diff.
 */
async function snapshotBaselinePlanIds(ctx: ReapPipelineContext): Promise<Set<string> | null> {
	if (
		!(
			ctx.project.hasSeeds &&
			ctx.input.outcome === "succeeded" &&
			hasAutoPlanRunFrontmatter(ctx.run)
		)
	) {
		return null;
	}
	try {
		const body =
			(await ctx.fs.readFile(join(ctx.project.localPath, ".seeds", "plans.jsonl"))) ?? "";
		return parsePlanIds(body);
	} catch {
		// Non-fatal — detection failure degrades to no auto-dispatch.
		return null;
	}
}

/** Re-emit finalize's collected per-record events through reap's real emit. */
async function replayFinalizeEvents(ctx: ReapPipelineContext, r: FinalizeResult): Promise<void> {
	for (const ev of r.events) {
		await ctx.emit(ev.kind, ev.payload);
	}
}

/**
 * Fold finalize's failed stages into reap's `errors[]` (the matching
 * `reap_failed` events already rode `r.events`, so record only — no re-emit).
 * `commits_ahead` is excluded: a rev-list failure is log-only in reap.
 */
function recordFinalizeErrors(ctx: ReapPipelineContext, r: FinalizeResult): void {
	for (const st of r.stages) {
		if (st.status !== "failed") continue;
		const step = finalizeStageToReapStep(st.stage);
		if (step === undefined) continue;
		ctx.recordError(step, st.error ?? "");
	}
}

/** Copy finalize's counts/flags onto the pipeline state accumulator. */
function applyFinalizeToState(state: ReapPipelineState, r: FinalizeResult): void {
	// The domain reads deltas back by the opaque keys it merged (warren-df3e);
	// absent count keys read as 0.
	const mulch = r.artifacts.mulch?.counts;
	const seeds = r.artifacts.seeds?.counts;
	state.mulchUpdated = mulch?.updated ?? 0;
	state.mulchSkipped = mulch?.skipped ?? 0;
	state.mulchAppended = mulch?.appended ?? 0;
	state.seedsClosed = seeds?.closed ?? 0;
	state.seedsCreated = seeds?.created ?? 0;
	// A bookkeeping commit was authored iff finalize emitted its committed event.
	state.seedsCommitted = r.events.some((e) => e.kind === "reap.seeds_committed");
	state.branchPushed = r.pushed;
	state.commitsAhead = r.commitsAhead;
	// warren-495d: push failed/timed out (commits left unpushed).
	state.finalizeFailed = r.stages.some((s) => s.stage === "branch_push" && s.status === "failed");
	// warren-5ea1: a warren-synthesized result (pod never posted) carries its cause.
	state.finalizeUnposted = r.unposted ?? null;
	// warren-b68d: trust a POLICY refusal only alongside a failed push stage.
	state.pushRejectedByPolicy =
		state.finalizeFailed && r.events.some((e) => e.kind === PUSH_REJECTED_EVENT);
}

/**
 * warren-72b9 / warren-89b0: classify zero-commit push via `classifyEmptyPush`
 * (noChanges vs droppedCommit). Run-level flip for ref-dispatch `no_changes`
 * is in `reapRun` (warren-ba08). Domain-owned; workspace gone post-terminate.
 */
async function emitEmptyPushIfNeeded(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
	r: FinalizeResult,
): Promise<void> {
	if (!(r.pushed && r.commitsAhead === 0)) return;
	const c = classifyEmptyPush(ctx.input.outcome === "succeeded", r.dirty, r.dirtyPaths ?? []);
	state.noChanges = c.noChanges;
	state.droppedCommit = c.droppedCommit;
	await ctx.emit("reap.empty_push", {
		branch: ctx.branch,
		baseBranch: ctx.baseBranch,
		dirty: r.dirty,
		dirtyPaths: r.dirtyPaths ?? [],
		droppedCommit: c.droppedCommit,
		noChanges: c.noChanges,
		message: c.message,
	});
}

/**
 * warren-a32a: reconstruct `snapshotWorkspacePlans`'s output from finalize's
 * captured `workspacePlansBody`. Gated on the baseline (which encodes the
 * hasSeeds + succeeded + frontmatter check) exactly as reap did.
 */
function resolveWorkspacePlans(
	baselinePlanIds: Set<string> | null,
	r: FinalizeResult,
): { ids: Set<string> | null; body: string | null } {
	if (baselinePlanIds === null) return { ids: null, body: null };
	const body = r.workspacePlansBody ?? "";
	return { ids: parsePlanIds(body), body };
}

async function autoDispatchStep(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
	plans: { ids: Set<string> | null; body: string | null; baseline: Set<string> | null },
): Promise<void> {
	// warren-486c: never dispatch against a mirror commit that never reached origin.
	if (state.mirrorDurabilityFailed) {
		await ctx.emit("auto_plan_run_skipped", { reason: "mirror_durability_failed" });
		return;
	}
	const autoDispatch = await dispatchAutoPlanRuns({
		run: ctx.run,
		project: ctx.project,
		workspacePlanIds: plans.ids,
		baselinePlanIds: plans.baseline,
		workspacePlansBody: plans.body,
		planRuns: ctx.input.repos.planRuns,
		emit: ctx.emit,
		fail: (step, err) => ctx.fail(step, err),
		...(ctx.input.issueTracker !== undefined ? { issueTracker: ctx.input.issueTracker } : {}),
	});
	state.autoPlanRunCreated = autoDispatch.created;
	state.autoPlanRunId = autoDispatch.id;
	state.autoPlanRunPlanId = autoDispatch.planId;
}

/** Auto-open PR (warren-f6af); a CI-fixer run self-skips inside runPrOpen (warren-a993). */
async function prOpenStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	const { branch } = ctx;
	if (
		!(
			ctx.input.autoOpenPr?.enabled === true &&
			ctx.input.outcome === "succeeded" &&
			state.branchPushed &&
			state.commitsAhead !== null &&
			state.commitsAhead > 0 &&
			branch !== null &&
			branch !== ctx.project.defaultBranch
		)
	) {
		return;
	}
	// warren-45e6: a reap input without a forge (tests) skips pr_open as if disabled.
	const forge = ctx.input.forge;
	if (forge === undefined) return;
	state.openedPr = await runPrOpen({
		autoOpen: ctx.input.autoOpenPr,
		forge,
		project: ctx.project,
		run: ctx.run,
		branch,
		baseBranch: ctx.baseBranch,
		workspacePath: ctx.workspacePath,
		previewOptedIn: ctx.input.previewConfig !== undefined,
		exec: ctx.exec,
		emit: ctx.emit,
		issueTracker: ctx.input.issueTracker,
		fail: (step, err) => ctx.fail(step, err),
		setPrUrl: (id, url) => ctx.input.repos.runs.setPrUrl(id, url),
		...(ctx.input.prTemplate !== undefined ? { prTemplate: ctx.input.prTemplate } : {}),
		...(ctx.input.sleep !== undefined ? { sleep: ctx.input.sleep } : {}),
	});
	state.prUrl = state.openedPr?.url ?? null;
}

/**
 * Preview launch (warren-f156 / docs/design/preview-environments.md). Skipped on a dropped
 * commit (warren-72b9). warren-4fbe: under a provider without `previewPorts` (K8s) skip
 * cleanly, surfacing `reap.preview_skipped_unsupported` when a project opted in.
 */
async function previewLaunchStep(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
): Promise<void> {
	const { sandboxId } = ctx.run;
	// Surface the skip only when a successful, committed run opted in (preview
	// WOULD have launched locally); otherwise stay silent.
	if (!ctx.provider.capabilities.previewPorts) {
		if (
			ctx.input.outcome === "succeeded" &&
			!state.droppedCommit &&
			ctx.input.previewConfig !== undefined &&
			ctx.input.portAllocator !== undefined
		) {
			await ctx.emit("reap.preview_skipped_unsupported", {
				reason: "provider_no_preview_ports",
				message: "preview launch skipped: provider does not support inbound preview ports",
			});
			ctx.log.info(
				{ event: "reap.preview_skipped_unsupported", reason: "provider_no_preview_ports" },
				"preview launch skipped: provider lacks preview-port capability",
			);
		}
		return;
	}
	if (
		!(
			ctx.input.outcome === "succeeded" &&
			!state.droppedCommit &&
			ctx.input.previewConfig !== undefined &&
			ctx.input.portAllocator !== undefined &&
			ctx.previewSidecars !== undefined &&
			sandboxId !== null
		)
	) {
		return;
	}
	// Resolve the sandbox sidecars facade through the neutral seam; a null
	// resolution (sandbox gone) skips the launch (warren-e24d).
	const sidecars = await ctx.previewSidecars(sandboxId);
	if (sidecars === null) return;
	const pv = await runPreviewLaunch({
		runId: ctx.run.id,
		sandboxId,
		workerId: ctx.run.workerId,
		outcome: ctx.input.outcome,
		previewConfig: ctx.input.previewConfig,
		portAllocator: ctx.input.portAllocator,
		sidecars,
		repos: ctx.input.repos,
		now: ctx.now,
		emit: ctx.emit,
		fail: ctx.fail,
		...(ctx.input.launchPreview !== undefined ? { launchPreviewFn: ctx.input.launchPreview } : {}),
	});
	state.previewLaunchState = pv.state;
	state.previewLaunchPort = pv.port;
}

async function previewAnnotateStep(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
): Promise<void> {
	const { openedPr, previewLaunchState } = state;
	// warren-45e6: the token gate is gone — the forge reports `no_credential`
	// as a seam result, and a forge without `pullRequestBodyEdit` reports the
	// skip as a sub-step event (forge-contract.md §5) inside runPreviewAnnotate.
	if (
		!(
			openedPr !== null &&
			previewLaunchState !== null &&
			ctx.input.autoOpenPr?.enabled === true &&
			ctx.input.forge !== undefined
		)
	) {
		return;
	}
	state.previewUrl = await runPreviewAnnotate({
		runId: ctx.run.id,
		prUrl: openedPr.url,
		repoRef: openedPr.repoRef,
		prRef: openedPr.prRef,
		prBody: openedPr.body,
		previewLaunchState,
		forge: ctx.input.forge,
		previewLaunchConfig: ctx.input.previewLaunchConfig,
		repos: ctx.input.repos,
		emit: ctx.emit,
		fail: ctx.fail,
	});
}

/** Zeroed finalize result used when the seam call itself throws (best-effort). */
function emptyFinalizeResult(): FinalizeResult {
	return {
		pushed: false,
		commitsAhead: null,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		artifacts: {},
		prBranch: null,
		stages: [],
		events: [],
	};
}

/**
 * Run the reap success pipeline, mutating `state` as each sub-step lands.
 * Every step is best-effort: failures surface as `reap_failed` events via
 * `ctx.fail` (or ride finalize's collected events) and never throw out of the
 * pipeline. The workspace-touching half runs as one `provider.finalize` call;
 * the interleaved DOMAIN steps (baseline snapshot, seed close, auto-dispatch,
 * PR/preview) bracket it in reap's original order.
 */
export async function runReapPipeline(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
): Promise<void> {
	// CLONE baseline read BEFORE finalize's plans mirror mutates it.
	const baselinePlanIds = await snapshotBaselinePlanIds(ctx);

	let finalizeResult: FinalizeResult;
	try {
		finalizeResult = await runProviderFinalize(ctx);
	} catch (err) {
		// The seam call should not throw on the tested paths (reapRun only runs
		// the pipeline once the workspace resolved), but degrade to a no-op rather
		// than crash reap if the workspace access fails inside finalize.
		await ctx.fail("workspace_lookup", err);
		finalizeResult = emptyFinalizeResult();
	}

	await replayFinalizeEvents(ctx, finalizeResult);
	recordFinalizeErrors(ctx, finalizeResult);
	applyFinalizeToState(state, finalizeResult);
	await emitEmptyPushIfNeeded(ctx, state, finalizeResult);

	// warren-e9e1 (leg 2): K8s merged in-pod, so apply finalize's mirror deltas to
	// the clone host-side. Gated on the K8s discriminator; the local path already
	// merged into the clone during finalize (byte-identical). See clone-apply.ts.
	if (ctx.workspacePath === null) await applyK8sCloneDeltas(ctx, state, finalizeResult);

	// warren-ab2b: persist the reap-time outcome facts (commits_ahead + parsed
	// diff totals) while the workspace / pushed branch is still readable.
	// Skipped when finalize never measured (commitsAhead null ⇒ all unknown).
	// warren-ba08: diff against the SAME ref finalize counted from (repair runs: a SHA).
	if (state.commitsAhead !== null) {
		state.diffStats = await recordOutcomeFacts({
			runId: ctx.run.id,
			workspacePath: ctx.workspacePath,
			branch: ctx.branch,
			baseBranch: finalizeResult.commitsAheadBase ?? ctx.baseBranch,
			project: ctx.project,
			commitsAhead: state.commitsAhead,
			branchPushed: state.branchPushed,
			exec: ctx.exec,
			...(ctx.input.forge !== undefined ? { forge: ctx.input.forge } : {}),
			log: ctx.log,
			setOutcomeFacts: (id, facts) => ctx.input.repos.runs.setOutcomeFacts(id, facts),
		});
	}

	// warren-df3e: the clone-side seed-close safety net is no longer a pipeline
	// step — it observes `post_reap` on the observation bus
	// (`./seed-close-lifecycle.ts`), keyed off the settled outcome + branchPushed.
	// Auto-plan-run detection still reads finalize's captured snapshot here.
	const workspacePlans = resolveWorkspacePlans(baselinePlanIds, finalizeResult);
	await autoDispatchStep(ctx, state, {
		ids: workspacePlans.ids,
		body: workspacePlans.body,
		baseline: baselinePlanIds,
	});

	// Pure domain orchestration — the workspace is still live (terminate runs
	// after the pipeline, back in reapRun).
	await prOpenStep(ctx, state);
	await previewLaunchStep(ctx, state);
	await previewAnnotateStep(ctx, state);
}

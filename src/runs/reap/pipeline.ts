/**
 * The reap "success pipeline" (warren-c65d): the long sequence of
 * best-effort sub-steps that runs once a non-`queued` run with a live
 * workspace and a surviving project clone reaches reap. Extracted from
 * `run.ts` so the top-level `reapRun` orchestrator stays under the
 * file-size / function-length budget; behavior is byte-for-byte the same.
 *
 * ## Routed through the RuntimeProvider seam (warren-1f56, pl-829f step 13)
 *
 * The workspace-touching half — the four tracker merges, the two
 * `chore(warren): {plot,seeds} state` bookkeeping commits, the branch push, and
 * the commits-ahead + dirtiness probe — now runs inside a SINGLE
 * `provider.finalize(handle, intent)` call (§4). finalize returns the mirror
 * deltas (counts), the per-record events it collected, the `dirty` flag, and the
 * workspace `.seeds/plans.jsonl` snapshot; the domain re-emits those events
 * through its real surface, derives `droppedCommit` + `reap.empty_push` from
 * `dirty`, and keeps the interleaved DOMAIN steps at the call-site:
 *   - `snapshotBaselinePlanIds` — reads the CLONE baseline BEFORE finalize's
 *     plans mirror appends to it.
 *   - `seedIdClose` — `sd close` via `SeedsCliDeps` (a domain integration with no
 *     provider-seam home).
 *   - auto-plan-run detection — off finalize's captured `workspacePlansBody`
 *     (the live workspace is gone after `terminate`).
 *   - PR-open / preview / preview-annotate — pure domain orchestration (§4).
 *
 * The pipeline mutates a {@link ReapPipelineState} accumulator in place
 * rather than returning a fresh object, so `reapRun` can read the same
 * field set in its terminal `reap.completed` emit / return regardless of
 * which branch of the dispatch chain ran.
 */

import { join } from "node:path";
import type { BurrowClient } from "../../burrow-client/client.ts";
import type { EventRow, ProjectRow, RunRow } from "../../db/schema.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	FinalizeStage,
	RunHandle,
	RuntimeProvider,
} from "../../runtime/contract.ts";
import { openPullRequest } from "../pr.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";
import { dispatchAutoPlanRuns, hasAutoPlanRunFrontmatter, parsePlanIds } from "./auto-plan-run.ts";
import { applyCloneDeltas } from "./clone-apply.ts";
import { runPrOpen } from "./pr-open.ts";
import { runPreviewAnnotate, runPreviewLaunch } from "./preview.ts";
import { closeRunSeedId } from "./seeds.ts";
import type { ReapExec, ReapFs, ReapRunInput, ReapStep } from "./types.ts";

/** Mutable accumulator carrying every result the pipeline can produce. */
export interface ReapPipelineState {
	mulchUpdated: number;
	mulchSkipped: number;
	mulchAppended: number;
	seedsClosed: number;
	seedsCreated: number;
	seedIdClosed: boolean;
	seedsCommitted: boolean;
	plotEventsAppended: number;
	plotsUpdated: number;
	plotEventsMirrored: number;
	plotCommitted: boolean;
	branchPushed: boolean;
	commitsAhead: number | null;
	droppedCommit: boolean;
	/** warren-e9e1 (leg 2): a `chore(warren): mirror state` commit applied the K8s
	 * finalize's mirror deltas to the clone. Always false on the local path. */
	cloneDeltasApplied: boolean;
	prUrl: string | null;
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
		seedIdClosed: false,
		seedsCommitted: false,
		plotEventsAppended: 0,
		plotsUpdated: 0,
		plotEventsMirrored: 0,
		plotCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		droppedCommit: false,
		cloneDeltasApplied: false,
		prUrl: null,
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
	/** Non-null whenever `workspacePath !== null` (same try-block). */
	readonly workerClient: BurrowClient | null;
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
	 * `reap_failed` event — used to fold finalize's failed stages back into the
	 * domain error trail when the matching `reap_failed` event was already
	 * re-emitted from `FinalizeResult.events`.
	 */
	readonly recordError: (step: ReapStep, message: string) => void;
}

/**
 * Map a finalize stage onto the reap step name reap's `errors[]` uses. Omitted
 * stages (`commits_ahead`) are NOT errors — reap only logs a rev-list failure.
 */
const FINALIZE_STAGE_TO_REAP_STEP: Partial<Record<FinalizeStage, ReapStep>> = {
	mulch_merge: "mulch_merge",
	seeds_mirror: "seeds_close",
	plans_mirror: "plans_mirror",
	plot_merge: "plot_merge",
	plot_commit: "plot_commit",
	seeds_commit: "seeds_commit",
	branch_push: "branch_push",
};

/**
 * warren-a32a: snapshot the project-clone baseline plans.jsonl BEFORE finalize's
 * plans mirror so auto_plan_run can diff workspace vs baseline. Must happen
 * before the mirror appends workspace plans into the project clone, which would
 * make the baseline identical to the workspace and defeat the diff.
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

/** Build the seam handle + neutral intent, then run the §4 finalize. */
async function runFinalize(ctx: ReapPipelineContext): Promise<FinalizeResult> {
	const handle: RunHandle = {
		runId: ctx.run.id,
		// burrowId is non-null in the pipeline branch (reapRun guards it).
		sandboxId: ctx.run.burrowId as string,
		providerRunId: ctx.run.burrowRunId ?? "",
	};
	// Merges run unconditionally in reap; the bookkeeping COMMITS gate on the
	// project flags. `mirror` gates the merges, `commit` the commits (warren-1f56).
	const commit: ("plot" | "seeds")[] = [];
	if (ctx.project.hasPlot) commit.push("plot");
	if (ctx.project.hasSeeds) commit.push("seeds");
	const intent: FinalizeIntent = {
		branch: ctx.branch ?? "",
		push: true,
		mirror: ["mulch", "seeds", "plans", "plot"],
		commit,
		projectClonePathHint: ctx.project.localPath,
		...(ctx.baseBranch !== null ? { baseBranch: ctx.baseBranch } : {}),
	};
	return ctx.provider.finalize(handle, intent);
}

/** Re-emit finalize's collected per-record events through reap's real emit. */
async function replayFinalizeEvents(ctx: ReapPipelineContext, r: FinalizeResult): Promise<void> {
	for (const ev of r.events) {
		await ctx.emit(ev.kind, ev.payload);
	}
}

/**
 * Fold finalize's failed stages into reap's `errors[]`. The matching
 * `reap_failed` events were already re-emitted from `r.events`, so this records
 * the error entry only (no second emit). `commits_ahead` is excluded — a
 * rev-list failure is log-only in reap.
 */
function recordFinalizeErrors(ctx: ReapPipelineContext, r: FinalizeResult): void {
	for (const st of r.stages) {
		if (st.status !== "failed") continue;
		const step = FINALIZE_STAGE_TO_REAP_STEP[st.stage];
		if (step === undefined) continue;
		ctx.recordError(step, st.error ?? "");
	}
}

/** Copy finalize's counts/flags onto the pipeline state accumulator. */
function applyFinalizeToState(state: ReapPipelineState, r: FinalizeResult): void {
	state.mulchUpdated = r.mirror.mulch?.updated ?? 0;
	state.mulchSkipped = r.mirror.mulch?.skipped ?? 0;
	state.mulchAppended = r.mirror.mulch?.appended ?? 0;
	state.seedsClosed = r.mirror.seeds?.closed ?? 0;
	state.seedsCreated = r.mirror.seeds?.created ?? 0;
	state.plotEventsAppended = r.mirror.plot?.eventsAppended ?? 0;
	state.plotsUpdated = r.mirror.plot?.plotsUpdated ?? 0;
	state.plotEventsMirrored = r.mirror.plot?.mirrored ?? 0;
	// A bookkeeping commit was authored iff finalize emitted its committed event.
	state.plotCommitted = r.events.some((e) => e.kind === "reap.plot_committed");
	state.seedsCommitted = r.events.some((e) => e.kind === "reap.seeds_committed");
	state.branchPushed = r.pushed;
	state.commitsAhead = r.commitsAhead;
}

/**
 * warren-72b9 / warren-f3bb: on a zero-commit push, derive `droppedCommit` from
 * finalize's `dirty` probe (dirty tree + succeeded = staged-but-uncommitted) and
 * surface it on `reap.empty_push`. The domain owns this because `droppedCommit`
 * needs the run outcome and the workspace is gone after `terminate`.
 */
async function emitEmptyPushIfNeeded(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
	r: FinalizeResult,
): Promise<void> {
	if (!(r.pushed && r.commitsAhead === 0)) return;
	state.droppedCommit = r.dirty && ctx.input.outcome === "succeeded";
	await ctx.emit("reap.empty_push", {
		branch: ctx.branch,
		baseBranch: ctx.baseBranch,
		dirty: r.dirty,
		droppedCommit: state.droppedCommit,
		message: r.dirty
			? "git push exited zero and the workspace still has uncommitted changes — agent staged work but never committed"
			: "git push exited zero but the branch landed no new commits — agent did not commit",
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

/**
 * warren-0d2d: host-side safety net — close the run's associated seed after a
 * successful reap even if the agent didn't call `sd close`. `sd close` is
 * idempotent; the updated `issues.jsonl` lands on origin via finalize's seeds
 * bookkeeping commit + push (already run by this point).
 */
async function seedIdCloseStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	const { seedId } = ctx.run;
	const { seedsCli } = ctx.input;
	if (
		!(
			ctx.input.outcome === "succeeded" &&
			seedId !== null &&
			ctx.project.hasSeeds &&
			seedsCli !== undefined
		)
	) {
		return;
	}
	try {
		state.seedIdClosed = await closeRunSeedId({
			seedId,
			projectPath: ctx.project.localPath,
			seedsCli,
			emit: ctx.emit,
		});
	} catch (err) {
		await ctx.fail("seed_id_close", err);
	}
}

async function autoDispatchStep(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
	plans: { ids: Set<string> | null; body: string | null; baseline: Set<string> | null },
): Promise<void> {
	const autoDispatch = await dispatchAutoPlanRuns({
		run: ctx.run,
		project: ctx.project,
		workspacePlanIds: plans.ids,
		baselinePlanIds: plans.baseline,
		workspacePlansBody: plans.body,
		planRuns: ctx.input.repos.planRuns,
		emit: ctx.emit,
		fail: (step, err) => ctx.fail(step, err),
		...(ctx.input.seedsCli !== undefined ? { seedsCli: ctx.input.seedsCli } : {}),
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
	state.prUrl = await runPrOpen({
		autoOpen: ctx.input.autoOpenPr,
		project: ctx.project,
		run: ctx.run,
		branch,
		baseBranch: ctx.baseBranch,
		workspacePath: ctx.workspacePath,
		previewOptedIn: ctx.input.previewConfig !== undefined,
		exec: ctx.exec,
		emit: ctx.emit,
		fail: (step, err) => ctx.fail(step, err),
		setPrUrl: (id, url) => ctx.input.repos.runs.setPrUrl(id, url),
		openPr: ctx.input.openPr ?? openPullRequest,
		...(ctx.input.prTemplate !== undefined ? { prTemplate: ctx.input.prTemplate } : {}),
		...(ctx.input.sleep !== undefined ? { sleep: ctx.input.sleep } : {}),
	});
}

/**
 * Preview launch (warren-f156 / SPEC §11.L). See runPreviewLaunch +
 * runPreviewAnnotate for the gate semantics. Skipped on a dropped commit
 * (warren-72b9).
 */
async function previewLaunchStep(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
): Promise<void> {
	const { burrowId } = ctx.run;
	if (
		!(
			ctx.input.outcome === "succeeded" &&
			!state.droppedCommit &&
			ctx.input.previewConfig !== undefined &&
			ctx.input.portAllocator !== undefined &&
			ctx.workerClient !== null &&
			burrowId !== null
		)
	) {
		return;
	}
	const pv = await runPreviewLaunch({
		runId: ctx.run.id,
		burrowId,
		workerId: ctx.run.workerId,
		outcome: ctx.input.outcome,
		previewConfig: ctx.input.previewConfig,
		portAllocator: ctx.input.portAllocator,
		workerClient: ctx.workerClient,
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
	const { prUrl, previewLaunchState } = state;
	if (
		!(
			prUrl !== null &&
			previewLaunchState !== null &&
			ctx.input.autoOpenPr?.enabled === true &&
			ctx.input.autoOpenPr.token !== ""
		)
	) {
		return;
	}
	state.previewUrl = await runPreviewAnnotate({
		runId: ctx.run.id,
		prUrl,
		previewLaunchState,
		autoOpenPr: ctx.input.autoOpenPr,
		previewLaunchConfig: ctx.input.previewLaunchConfig,
		repos: ctx.input.repos,
		emit: ctx.emit,
		fail: ctx.fail,
		...(ctx.input.annotatePrPreview !== undefined
			? { annotatePrPreviewFn: ctx.input.annotatePrPreview }
			: {}),
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
		mirror: {},
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
		finalizeResult = await runFinalize(ctx);
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
	if (ctx.workspacePath === null) await applyCloneDeltas(ctx, state, finalizeResult);

	// Domain safety-net close + auto-plan-run detection off finalize's snapshot.
	await seedIdCloseStep(ctx, state);
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

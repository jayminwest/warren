/**
 * The reap "success pipeline" (warren-c65d): the long sequence of
 * best-effort sub-steps that runs once a non-`queued` run with a live
 * workspace and a surviving project clone reaches reap. Extracted from
 * `run.ts` so the top-level `reapRun` orchestrator stays under the
 * file-size / function-length budget; behavior is byte-for-byte the same.
 *
 * The pipeline mutates a {@link ReapPipelineState} accumulator in place
 * rather than returning a fresh object, so `reapRun` can read the same
 * field set in its terminal `reap.completed` emit / return regardless of
 * which branch of the dispatch chain ran.
 */

import { join } from "node:path";
import type { BurrowClient } from "../../burrow-client/client.ts";
import type { EventRow, ProjectRow, RunRow } from "../../db/schema.ts";
import { openPullRequest } from "../pr.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";
import { dispatchAutoPlanRuns, hasAutoPlanRunFrontmatter, parsePlanIds } from "./auto-plan-run.ts";
import { mergeMulch } from "./mulch.ts";
import { mergePlot } from "./plot-merge.ts";
import { runPrOpen } from "./pr-open.ts";
import { runPreviewAnnotate, runPreviewLaunch } from "./preview.ts";
import { closeRunSeedId, mirrorPlans, mirrorSeeds } from "./seeds.ts";
import { stagePlotForCommit, stageSeedsForCommit } from "./stage.ts";
import type { ReapExec, ReapFs, ReapRunInput, ReapStep } from "./types.ts";
import { isWorkspaceDirty } from "./util.ts";

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
	/** Non-null in this branch: the burrow exposed a workspace path. */
	readonly workspacePath: string;
	readonly branch: string | null;
	readonly baseBranch: string | null;
	/** Non-null whenever `workspacePath !== null` (same try-block). */
	readonly workerClient: BurrowClient | null;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly now: () => Date;
	readonly log: BoundBridgeLogger;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>;
}

async function mergeMulchStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	try {
		const result = await mergeMulch(
			ctx.workspacePath,
			ctx.project.localPath,
			ctx.fs,
			ctx.emit,
			ctx.fail,
		);
		state.mulchUpdated = result.updated;
		state.mulchSkipped = result.skipped;
		state.mulchAppended = result.appended;
	} catch (err) {
		await ctx.fail("mulch_merge", err);
	}
}

async function mirrorSeedsStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	try {
		// workerClient is set whenever workspacePath !== null (both land in the
		// same try-block in reapRun), so the cast is sound.
		const mirrorResult = await mirrorSeeds({
			burrowClient: ctx.workerClient as BurrowClient,
			burrowId: ctx.run.burrowId as string,
			projectPath: ctx.project.localPath,
			fs: ctx.fs,
			emit: ctx.emit,
		});
		state.seedsClosed = mirrorResult.closed;
		state.seedsCreated = mirrorResult.created;
	} catch (err) {
		await ctx.fail("seeds_close", err);
	}
}

/**
 * warren-a32a: snapshot the project-clone baseline plans.jsonl BEFORE
 * mirrorPlans so auto_plan_run can diff workspace vs baseline. Must happen
 * before mirrorPlans appends workspace plans into the project clone, which
 * would make the baseline identical to the workspace and defeat the diff
 * (warren-d9a2 ordering bug).
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

/**
 * warren-d9a2: mirror plans.jsonl from workspace → project clone, same shape
 * as mirrorSeeds. Without this, stageSeedsForCommit copies the OLD project
 * baseline plans.jsonl into the workspace, overwriting the agent's newly
 * created plans.
 */
async function mirrorPlansStep(ctx: ReapPipelineContext): Promise<void> {
	try {
		await mirrorPlans({
			burrowClient: ctx.workerClient as BurrowClient,
			burrowId: ctx.run.burrowId as string,
			projectPath: ctx.project.localPath,
			fs: ctx.fs,
			emit: ctx.emit,
		});
	} catch (err) {
		await ctx.fail("plans_mirror", err);
	}
}

async function mergePlotStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	try {
		const result = await mergePlot(
			ctx.workspacePath,
			ctx.project.localPath,
			ctx.fs,
			ctx.emit,
			ctx.fail,
		);
		state.plotEventsAppended = result.eventsAppended;
		state.plotsUpdated = result.plotsUpdated;
		state.plotEventsMirrored = result.mirrored;
	} catch (err) {
		await ctx.fail("plot_merge", err);
	}
}

/**
 * warren-343a / shape (a) commit-through-reap: replicate the merged `.plot/`
 * from the project clone into the workspace and author a `chore(warren): plot
 * state` commit when there's a staged delta the agent never committed. This is
 * the carrier for host-side appender writes (defaultPlotAppender,
 * defaultPlanRunPlotAppender, autoTransitionPlotToDone — see SPEC §11.O) and
 * for any agent-emitted `.plot/` lines that the agent left uncommitted. Skipped
 * when the project has no `.plot/`. Best-effort: failures emit `reap_failed`
 * step=`plot_commit` and do not fail the run.
 */
async function plotCommitStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	if (!ctx.project.hasPlot) return;
	try {
		state.plotCommitted = await stagePlotForCommit({
			workspacePath: ctx.workspacePath,
			projectPath: ctx.project.localPath,
			fs: ctx.fs,
			exec: ctx.exec,
			emit: ctx.emit,
		});
	} catch (err) {
		await ctx.fail("plot_commit", err, join(ctx.workspacePath, ".plot"));
	}
}

/**
 * warren-a32a: snapshot the workspace's plans.jsonl BEFORE stageSeedsForCommit
 * (which copies project→workspace). The baseline was already captured before
 * mirrorPlans.
 */
async function snapshotWorkspacePlans(
	ctx: ReapPipelineContext,
	baselinePlanIds: Set<string> | null,
): Promise<{ ids: Set<string> | null; body: string | null }> {
	if (baselinePlanIds === null) return { ids: null, body: null };
	try {
		const body = (await ctx.fs.readFile(join(ctx.workspacePath, ".seeds", "plans.jsonl"))) ?? "";
		return { ids: parsePlanIds(body), body };
	} catch {
		// Non-fatal — detection failure degrades to no auto-dispatch.
		return { ids: null, body: null };
	}
}

/**
 * warren-0d2d: host-side safety net — close the run's associated seed after a
 * successful reap even if the agent didn't call `sd close`. Runs after
 * mirrorSeeds (workspace → project clone) so an agent-side close is already
 * reflected; `sd close` is idempotent. Runs before stageSeedsForCommit so the
 * updated issues.jsonl is picked up into the workspace commit and lands on
 * origin via branch_push.
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

async function seedsCommitStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	if (!ctx.project.hasSeeds) return;
	try {
		state.seedsCommitted = await stageSeedsForCommit({
			workspacePath: ctx.workspacePath,
			projectPath: ctx.project.localPath,
			fs: ctx.fs,
			exec: ctx.exec,
			emit: ctx.emit,
		});
	} catch (err) {
		await ctx.fail("seeds_commit", err, join(ctx.workspacePath, ".seeds"));
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
		planRuns: ctx.input.repos.planRuns as unknown as {
			create: (i: unknown) => Promise<{ planRun: { id: string } }>;
		},
		emit: ctx.emit,
		fail: (step, err) => ctx.fail(step, err),
		...(ctx.input.seedsCli !== undefined ? { seedsCli: ctx.input.seedsCli } : {}),
	});
	state.autoPlanRunCreated = autoDispatch.created;
	state.autoPlanRunId = autoDispatch.id;
	state.autoPlanRunPlanId = autoDispatch.planId;
}

async function pushStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	try {
		await ctx.exec.run(
			"git",
			["push", "origin", ctx.branch !== null ? `HEAD:${ctx.branch}` : "HEAD"],
			{ cwd: ctx.workspacePath, timeoutMs: 60_000 },
		);
		state.branchPushed = true;
	} catch (err) {
		await ctx.fail("branch_push", err, ctx.workspacePath);
	}
}

/**
 * Empty-push observability (warren-f3bb): count commits ahead of defaultBranch,
 * surface zero as `reap.empty_push`, pin on `commitsAhead`; rev-list failure
 * degrades to `commitsAhead: null`.
 */
async function commitsAheadStep(ctx: ReapPipelineContext, state: ReapPipelineState): Promise<void> {
	const { baseBranch } = ctx;
	if (!(state.branchPushed && baseBranch !== null)) return;
	try {
		const out = await ctx.exec.run("git", ["rev-list", "--count", `${baseBranch}..HEAD`], {
			cwd: ctx.workspacePath,
			timeoutMs: 10_000,
		});
		const parsed = Number.parseInt(out.stdout.trim(), 10);
		state.commitsAhead = Number.isFinite(parsed) ? parsed : null;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		ctx.log.info(
			{ event: "reap.commits_ahead_failed", err: reason },
			"reap commits-ahead count failed",
		);
	}
	if (state.commitsAhead !== 0) return;
	// warren-72b9: dirty tree + zero commits = staged-but-uncommitted.
	const dirty = await isWorkspaceDirty(ctx.exec, ctx.workspacePath);
	state.droppedCommit = dirty && ctx.input.outcome === "succeeded";
	await ctx.emit("reap.empty_push", {
		branch: ctx.branch,
		baseBranch,
		dirty,
		droppedCommit: state.droppedCommit,
		message: dirty
			? "git push exited zero and the workspace still has uncommitted changes — agent staged work but never committed"
			: "git push exited zero but the branch landed no new commits — agent did not commit",
	});
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

/**
 * Run the reap success pipeline, mutating `state` as each sub-step lands.
 * Every step is best-effort: failures surface as `reap_failed` events via
 * `ctx.fail` and never throw out of the pipeline. The sub-steps run in a fixed
 * order — several depend on earlier ones (e.g. the plans baseline snapshot must
 * precede mirrorPlans; commitsAhead must follow the branch push).
 */
export async function runReapPipeline(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
): Promise<void> {
	await mergeMulchStep(ctx, state);
	await mirrorSeedsStep(ctx, state);
	const baselinePlanIds = await snapshotBaselinePlanIds(ctx);
	await mirrorPlansStep(ctx);
	await mergePlotStep(ctx, state);
	await plotCommitStep(ctx, state);
	const workspacePlans = await snapshotWorkspacePlans(ctx, baselinePlanIds);
	await seedIdCloseStep(ctx, state);
	await seedsCommitStep(ctx, state);
	await autoDispatchStep(ctx, state, {
		ids: workspacePlans.ids,
		body: workspacePlans.body,
		baseline: baselinePlanIds,
	});
	await pushStep(ctx, state);
	await commitsAheadStep(ctx, state);
	await prOpenStep(ctx, state);
	await previewLaunchStep(ctx, state);
	await previewAnnotateStep(ctx, state);
}

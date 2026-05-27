import { join } from "node:path";
import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { EventRow, RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import { openPullRequest } from "../pr.ts";
import { dispatchAutoPlanRuns, hasAutoPlanRunFrontmatter, parsePlanIds } from "./auto-plan-run.ts";
import { mergeMulch } from "./mulch.ts";
import { mergePlot } from "./plot-merge.ts";
import { runPrOpen } from "./pr-open.ts";
import { runPreviewAnnotate, runPreviewLaunch } from "./preview.ts";
import { mirrorPlans, mirrorSeeds } from "./seeds.ts";
import { stagePlotForCommit, stageSeedsForCommit } from "./stage.ts";
import { inferFailureReason, isTerminal, transitionToTerminal } from "./state.ts";
import type { ReapRunInput, ReapRunResult, ReapStep, ReapStepError } from "./types.ts";
import { createSeqAllocator, defaultExec, defaultFs } from "./util.ts";

export async function reapRun(input: ReapRunInput): Promise<ReapRunResult> {
	const fs = input.fs ?? defaultFs;
	const exec = input.exec ?? defaultExec;
	const now = input.now ?? (() => new Date());

	const run = await input.repos.runs.require(input.runId);
	if (isTerminal(run.state)) {
		input.logger?.info?.(
			{ runId: run.id, state: run.state },
			"reap skipped: run already in terminal state",
		);
		const idempotentPreviewState =
			run.previewState === "live" || run.previewState === "failed" ? run.previewState : null;
		return {
			state: run.state as RunTerminalState,
			failureReason: run.failureReason,
			mulchUpdated: 0,
			mulchSkipped: 0,
			mulchAppended: 0,
			seedsClosed: 0,
			seedsCreated: 0,
			plotEventsAppended: 0,
			plotsUpdated: 0,
			plotEventsMirrored: 0,
			plotCommitted: false,
			seedsCommitted: false,
			branchPushed: false,
			commitsAhead: null,
			prUrl: run.prUrl,
			previewState: idempotentPreviewState,
			previewPort: run.previewPort,
			previewUrl: null,
			autoPlanRunCreated: false,
			autoPlanRunId: null,
			autoPlanRunPlanId: null,
			errors: [],
			alreadyTerminal: true,
		};
	}

	// State on entry is the discriminator: still `queued` means the bridge
	// never claimed it (no events ever flowed from burrow), so this is a
	// "burrow never started the run" failure rather than a real crash.
	const stateOnEntry = run.state;

	// `run.projectId` is null when the project was deleted while the run
	// existed (warren-5f19): the FK is `ON DELETE SET NULL`, so the run
	// row survives the delete as an orphan. We can still finalize the
	// state (the events were already streamed), but the mulch-merge,
	// seeds-close, and branch-push sub-steps target the project clone on
	// disk, which is gone. Skip them and emit a single system event so
	// operators can see why reap was a no-op.
	const project = run.projectId !== null ? await input.repos.projects.get(run.projectId) : null;
	const seq = createSeqAllocator((await input.repos.events.maxSeqForRun(run.id)) ?? 0);
	const errors: ReapStepError[] = [];
	const emit = async (kind: string, payload: unknown): Promise<EventRow> => {
		const row = await input.repos.events.append({
			runId: run.id,
			burrowEventSeq: seq.next(),
			ts: now().toISOString(),
			kind,
			stream: "system",
			payload,
		});
		input.broker?.publish(run.id, row);
		return row;
	};
	const fail = async (step: ReapStep, err: unknown, path?: string): Promise<void> => {
		const message = err instanceof Error ? err.message : String(err);
		const stepError: ReapStepError =
			path !== undefined ? { step, message, path } : { step, message };
		errors.push(stepError);
		await emit("reap_failed", stepError);
		input.logger?.error?.({ runId: run.id, step, err: message, path }, "reap step failed");
	};

	let mulchUpdated = 0;
	let mulchSkipped = 0;
	let mulchAppended = 0;
	let seedsClosed = 0;
	let seedsCreated = 0;
	let plotEventsAppended = 0;
	let plotsUpdated = 0;
	let plotEventsMirrored = 0;
	let plotCommitted = false;
	let seedsCommitted = false;
	let branchPushed = false;
	let commitsAhead: number | null = null;
	let prUrl: string | null = null;
	let previewLaunchState: "live" | "failed" | null = null;
	let previewLaunchPort: number | null = null;
	let previewUrl: string | null = null;
	let autoPlanRunCreated = false;
	let autoPlanRunId: string | null = null;
	let autoPlanRunPlanId: string | null = null;

	let workspacePath: string | null = null;
	let branch: string | null = null;
	let workerClient: BurrowClient | null = null;
	if (run.burrowId === null) {
		await fail("workspace_lookup", new Error("run has no burrow_id; nothing to reap from"));
	} else {
		try {
			workerClient = (await input.burrowClientPool.clientFor({ burrowId: run.burrowId })).client;
			const burrow = await withTransportMapping(workerClient.config, () =>
				(workerClient as BurrowClient).http.burrows.get(run.burrowId as string),
			);
			workspacePath = burrow.workspacePath;
			branch = typeof burrow.branch === "string" && burrow.branch !== "" ? burrow.branch : null;
		} catch (err) {
			await fail("workspace_lookup", err);
		}
	}
	// Base branch for the empty-push count comes from the project row, not
	// burrow: burrow's `BurrowRow` does not expose `baseBranch` at the top
	// level (it's tucked into `providerStateJson`), and warren's projects
	// table already pins `defaultBranch` (notNull) at clone time. For V1
	// the primary flow always carves the workspace branch off
	// `project.defaultBranch`, so this is the correct reference for
	// `git rev-list --count <baseBranch>..HEAD`.
	const baseBranch: string | null = project?.defaultBranch ?? null;

	if (workspacePath !== null && project !== null) {
		try {
			const result = await mergeMulch(workspacePath, project.localPath, fs, emit, fail);
			mulchUpdated = result.updated;
			mulchSkipped = result.skipped;
			mulchAppended = result.appended;
		} catch (err) {
			await fail("mulch_merge", err);
		}

		try {
			// workerClient is set whenever workspacePath !== null (both land in
			// the same try-block above), so the cast is sound.
			const mirrorResult = await mirrorSeeds({
				burrowClient: workerClient as BurrowClient,
				burrowId: run.burrowId as string,
				projectPath: project.localPath,
				fs,
				emit,
			});
			seedsClosed = mirrorResult.closed;
			seedsCreated = mirrorResult.created;
		} catch (err) {
			await fail("seeds_close", err);
		}

		// warren-a32a: snapshot the project-clone baseline plans.jsonl BEFORE
		// mirrorPlans so auto_plan_run can diff workspace vs baseline. Must
		// happen here because mirrorPlans appends workspace plans into the
		// project clone, which would make the baseline identical to the
		// workspace and defeat the diff (warren-d9a2 ordering bug).
		let baselinePlanIds: Set<string> | null = null;
		if (project.hasSeeds && input.outcome === "succeeded" && hasAutoPlanRunFrontmatter(run)) {
			try {
				const baselineBody =
					(await fs.readFile(join(project.localPath, ".seeds", "plans.jsonl"))) ?? "";
				baselinePlanIds = parsePlanIds(baselineBody);
			} catch {
				// Non-fatal — detection failure degrades to no auto-dispatch.
			}
		}

		// warren-d9a2: mirror plans.jsonl from workspace → project clone,
		// same shape as mirrorSeeds above. Without this, stageSeedsForCommit
		// copies the OLD project baseline plans.jsonl into the workspace,
		// overwriting the agent's newly-created plans.
		try {
			await mirrorPlans({
				burrowClient: workerClient as BurrowClient,
				burrowId: run.burrowId as string,
				projectPath: project.localPath,
				fs,
				emit,
			});
		} catch (err) {
			await fail("plans_mirror", err);
		}

		try {
			const result = await mergePlot(workspacePath, project.localPath, fs, emit, fail);
			plotEventsAppended = result.eventsAppended;
			plotsUpdated = result.plotsUpdated;
			plotEventsMirrored = result.mirrored;
		} catch (err) {
			await fail("plot_merge", err);
		}

		// warren-343a / shape (a) commit-through-reap: replicate the merged
		// `.plot/` from the project clone into the workspace and author a
		// `chore(warren): plot state` commit when there's a staged delta the
		// agent never committed. This is the carrier for host-side appender
		// writes (defaultPlotAppender, defaultPlanRunPlotAppender,
		// autoTransitionPlotToDone — see SPEC §11.O) and for any
		// agent-emitted `.plot/` lines that the agent left uncommitted.
		// Skipped when the project has no `.plot/`. Best-effort: failures
		// emit `reap_failed` step=`plot_commit` and do not fail the run.
		if (project.hasPlot) {
			try {
				plotCommitted = await stagePlotForCommit({
					workspacePath,
					projectPath: project.localPath,
					fs,
					exec,
					emit,
				});
			} catch (err) {
				await fail("plot_commit", err, join(workspacePath, ".plot"));
			}
		}

		// warren-7ecc: seeds commit-through-reap. See stageSeedsForCommit.

		// warren-a32a: snapshot the workspace's plans.jsonl BEFORE
		// stageSeedsForCommit (which copies project→workspace). Baseline
		// was already captured above mirrorPlans.
		let workspacePlanIds: Set<string> | null = null;
		let workspacePlansBody: string | null = null;
		if (baselinePlanIds !== null) {
			try {
				workspacePlansBody =
					(await fs.readFile(join(workspacePath, ".seeds", "plans.jsonl"))) ?? "";
				workspacePlanIds = parsePlanIds(workspacePlansBody);
			} catch {
				// Non-fatal — detection failure degrades to no auto-dispatch.
			}
		}

		if (project.hasSeeds) {
			try {
				seedsCommitted = await stageSeedsForCommit({
					workspacePath,
					projectPath: project.localPath,
					fs,
					exec,
					emit,
				});
			} catch (err) {
				await fail("seeds_commit", err, join(workspacePath, ".seeds"));
			}
		}

		// warren-a32a: auto-dispatch plan-runs for plans the agent created.
		const autoDispatch = await dispatchAutoPlanRuns({
			run,
			project,
			workspacePlanIds,
			baselinePlanIds,
			workspacePlansBody,
			planRuns: input.repos.planRuns as unknown as {
				create: (i: unknown) => Promise<{ planRun: { id: string } }>;
			},
			emit,
			fail: (step, err) => fail(step, err),
		});
		autoPlanRunCreated = autoDispatch.created;
		autoPlanRunId = autoDispatch.id;
		autoPlanRunPlanId = autoDispatch.planId;

		try {
			await exec.run("git", ["push", "origin", branch !== null ? `HEAD:${branch}` : "HEAD"], {
				cwd: workspacePath,
				timeoutMs: 60_000,
			});
			branchPushed = true;
		} catch (err) {
			await fail("branch_push", err, workspacePath);
		}

		// Empty-push observability (warren-f3bb): branchPushed alone can't
		// tell apart a real-work push from a no-op against an unchanged
		// HEAD (the agent never `git commit`-ed). Count commits ahead of
		// the project's defaultBranch; surface zero as `reap.empty_push`
		// and pin the count on `commitsAhead`. rev-list failures are
		// non-fatal — a missing base ref or transient git error degrades
		// to `commitsAhead: null` rather than failing the reap step.
		if (branchPushed && baseBranch !== null) {
			try {
				const out = await exec.run("git", ["rev-list", "--count", `${baseBranch}..HEAD`], {
					cwd: workspacePath,
					timeoutMs: 10_000,
				});
				const parsed = Number.parseInt(out.stdout.trim(), 10);
				commitsAhead = Number.isFinite(parsed) ? parsed : null;
			} catch (err) {
				input.logger?.info?.(
					{ runId: run.id, err: err instanceof Error ? err.message : String(err) },
					"reap commits-ahead count failed; continuing",
				);
			}
			if (commitsAhead === 0) {
				await emit("reap.empty_push", {
					branch,
					baseBranch,
					message:
						"git push exited zero but the branch landed no new commits — agent did not commit",
				});
			}
		}

		// Auto-open PR (warren-f6af). See runPrOpen for the gate semantics.
		if (
			input.autoOpenPr?.enabled === true &&
			input.outcome === "succeeded" &&
			branchPushed &&
			commitsAhead !== null &&
			commitsAhead > 0 &&
			branch !== null &&
			branch !== project.defaultBranch
		) {
			prUrl = await runPrOpen({
				autoOpen: input.autoOpenPr,
				project,
				run,
				branch,
				baseBranch,
				workspacePath: workspacePath as string,
				previewOptedIn: input.previewConfig !== undefined,
				exec,
				emit,
				fail: (step, err) => fail(step, err),
				setPrUrl: (id, url) => input.repos.runs.setPrUrl(id, url),
				openPr: input.openPr ?? openPullRequest,
				...(input.prTemplate !== undefined ? { prTemplate: input.prTemplate } : {}),
			});
		}

		// Preview launch (warren-f156 / SPEC §11.L). See runPreviewLaunch +
		// runPreviewAnnotate for the gate semantics.
		if (
			input.outcome === "succeeded" &&
			input.previewConfig !== undefined &&
			input.portAllocator !== undefined &&
			workerClient !== null &&
			run.burrowId !== null
		) {
			const pv = await runPreviewLaunch({
				runId: run.id,
				burrowId: run.burrowId,
				workerId: run.workerId,
				outcome: input.outcome,
				previewConfig: input.previewConfig,
				portAllocator: input.portAllocator,
				workerClient,
				repos: input.repos,
				now,
				emit,
				fail,
				...(input.launchPreview !== undefined ? { launchPreviewFn: input.launchPreview } : {}),
			});
			previewLaunchState = pv.state;
			previewLaunchPort = pv.port;
		}

		if (
			prUrl !== null &&
			previewLaunchState !== null &&
			input.autoOpenPr?.enabled === true &&
			input.autoOpenPr.token !== ""
		) {
			previewUrl = await runPreviewAnnotate({
				runId: run.id,
				prUrl,
				previewLaunchState,
				autoOpenPr: input.autoOpenPr,
				previewLaunchConfig: input.previewLaunchConfig,
				repos: input.repos,
				emit,
				fail,
				...(input.annotatePrPreview !== undefined
					? { annotatePrPreviewFn: input.annotatePrPreview }
					: {}),
			});
		}
	} else if (workspacePath !== null && project === null) {
		await emit("reap.orphaned", {
			projectId: run.projectId,
			message: "project was deleted; skipping mulch merge, seeds close, and branch push",
		});
	}

	const failureReason: RunFailureReason | null =
		input.outcome === "failed"
			? (input.failureReason ?? (await inferFailureReason(input.repos, run.id, stateOnEntry)))
			: null;

	const finalState = await transitionToTerminal(
		input.repos,
		run.id,
		stateOnEntry,
		input.outcome,
		now(),
		failureReason,
	);

	await emit("reap.completed", {
		state: finalState,
		failureReason,
		mulch: { updated: mulchUpdated, skipped: mulchSkipped, appended: mulchAppended },
		seeds: { closed: seedsClosed, created: seedsCreated, committed: seedsCommitted },
		plot: {
			eventsAppended: plotEventsAppended,
			plotsUpdated,
			mirrored: plotEventsMirrored,
			committed: plotCommitted,
		},
		branchPushed,
		commitsAhead,
		prUrl,
		previewState: previewLaunchState,
		previewPort: previewLaunchPort,
		previewUrl,
		autoPlanRun: { created: autoPlanRunCreated, id: autoPlanRunId, planId: autoPlanRunPlanId },
		errors,
	});

	if (input.broker !== undefined) input.broker.close(run.id);

	input.logger?.info?.(
		{
			runId: run.id,
			state: finalState,
			failureReason,
			mulchUpdated,
			mulchSkipped,
			mulchAppended,
			seedsClosed,
			seedsCreated,
			seedsCommitted,
			plotEventsAppended,
			plotsUpdated,
			plotEventsMirrored,
			plotCommitted,
			branchPushed,
			commitsAhead,
			prUrl,
			previewState: previewLaunchState,
			previewPort: previewLaunchPort,
			previewUrl,
			autoPlanRunCreated,
			autoPlanRunId,
			errored: errors.length > 0,
		},
		"reap completed",
	);

	return {
		state: finalState,
		failureReason,
		mulchUpdated,
		mulchSkipped,
		mulchAppended,
		seedsClosed,
		seedsCreated,
		plotEventsAppended,
		plotsUpdated,
		plotEventsMirrored,
		plotCommitted,
		seedsCommitted,
		branchPushed,
		commitsAhead,
		prUrl,
		previewState: previewLaunchState,
		previewPort: previewLaunchPort,
		previewUrl,
		autoPlanRunCreated,
		autoPlanRunId,
		autoPlanRunPlanId,
		errors,
		alreadyTerminal: false,
	};
}

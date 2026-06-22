import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { EventRow, RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import { bindBridgeLogger } from "../stream/index.ts";
import { runWorkspaceDestroy } from "./destroy.ts";
import { createPipelineState, runReapPipeline } from "./pipeline.ts";
import { inferFailureReason, isTerminal, transitionToTerminal } from "./state.ts";
import type { ReapRunInput, ReapRunResult, ReapStep, ReapStepError } from "./types.ts";
import { buildAlreadyTerminalResult, createSeqAllocator, defaultExec, defaultFs } from "./util.ts";

export async function reapRun(input: ReapRunInput): Promise<ReapRunResult> {
	const fs = input.fs ?? defaultFs;
	const exec = input.exec ?? defaultExec;
	const now = input.now ?? (() => new Date());

	const run = await input.repos.runs.require(input.runId);
	const log = bindBridgeLogger(input.logger, { run_id: run.id }); // warren-9f06: bind run_id once
	if (isTerminal(run.state)) {
		log.info({ event: "reap.skipped", state: run.state }, "reap skipped: run already terminal");
		return buildAlreadyTerminalResult(run);
	}

	// State on entry is the discriminator: still `queued` means the bridge
	// never claimed it (no events flowed from burrow) — "never started" (warren-5e53).
	const stateOnEntry = run.state;

	// `run.projectId` is null when the project was deleted while the run
	// existed (warren-5f19): the FK is `ON DELETE SET NULL`, so the run
	// row survives as an orphan. We can still finalize the state, but the
	// mulch-merge, seeds-close, and branch-push sub-steps target the
	// project clone on disk, which is gone. Skip them and emit a system so
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
		log.error({ event: "reap.step_failed", step, err: message, path }, "reap step failed");
	};

	const state = createPipelineState();

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
	// burrow (which doesn't expose baseBranch at the top level). For V1 the
	// primary flow always carves the workspace branch off
	// `project.defaultBranch`, the correct ref for `rev-list --count`.
	const baseBranch: string | null = project?.defaultBranch ?? null;

	// warren-df71: a conversation run must NOT push a branch / commit `.plot/`
	// / open a PR (send-off owns its plotSync PR; this pipeline made junk PRs).
	if (run.mode === "conversation" && workspacePath !== null) {
		await emit("reap.branch_push_skipped", { reason: "conversation_run" });
	} else if (stateOnEntry === "queued" && workspacePath !== null && project !== null) {
		await emit("reap.never_started_skip", { message: "agent never ran; skipping pipeline" });
	} else if (stateOnEntry !== "queued" && workspacePath !== null && project !== null) {
		await runReapPipeline(
			{
				input,
				run,
				project,
				workspacePath,
				branch,
				baseBranch,
				workerClient,
				fs,
				exec,
				now,
				log,
				emit,
				fail,
			},
			state,
		);
	} else if (workspacePath !== null && project === null) {
		await emit("reap.orphaned", {
			projectId: run.projectId,
			message: "project was deleted; skipping mulch merge, seeds close, and branch push",
		});
	}

	// warren-72b9: `droppedCommit` flips an otherwise-succeeded run to
	// `failed`/`dropped_commit` so it can't masquerade as success.
	const effectiveOutcome: RunTerminalState = state.droppedCommit ? "failed" : input.outcome;

	let failureReason: RunFailureReason | null = null;
	if (state.droppedCommit) {
		failureReason = "dropped_commit";
	} else if (effectiveOutcome === "failed") {
		failureReason =
			input.failureReason ?? (await inferFailureReason(input.repos, run.id, stateOnEntry));
	}

	const finalState = await transitionToTerminal(
		input.repos,
		run.id,
		stateOnEntry,
		effectiveOutcome,
		now(),
		failureReason,
	);

	await emit("reap.completed", {
		state: finalState,
		failureReason,
		mulch: {
			updated: state.mulchUpdated,
			skipped: state.mulchSkipped,
			appended: state.mulchAppended,
		},
		seeds: {
			closed: state.seedsClosed,
			created: state.seedsCreated,
			seedIdClosed: state.seedIdClosed,
			committed: state.seedsCommitted,
		},
		plot: {
			eventsAppended: state.plotEventsAppended,
			plotsUpdated: state.plotsUpdated,
			mirrored: state.plotEventsMirrored,
			committed: state.plotCommitted,
		},
		branchPushed: state.branchPushed,
		commitsAhead: state.commitsAhead,
		prUrl: state.prUrl,
		previewState: state.previewLaunchState,
		previewPort: state.previewLaunchPort,
		previewUrl: state.previewUrl,
		autoPlanRun: {
			created: state.autoPlanRunCreated,
			id: state.autoPlanRunId,
			planId: state.autoPlanRunPlanId,
		},
		errors,
	});

	// Final sub-step (warren-0d89): destroy the burrow workspace now that
	// every result has been extracted and the branch pushed. Best-effort —
	// skipped for conversation runs and still-live previews, and a failure
	// surfaces as `reap_failed` step=`workspace_destroy` without blocking
	// the terminal-state transition above.
	const workspaceDestroyed = await runWorkspaceDestroy({
		run,
		previewLaunchState: state.previewLaunchState,
		workerClient,
		repos: input.repos,
		emit,
		fail: (step, err) => fail(step, err),
	});

	if (input.broker !== undefined) input.broker.close(run.id);

	log.info(
		{
			event: "reap.completed",
			state: finalState,
			failureReason,
			mulchUpdated: state.mulchUpdated,
			mulchSkipped: state.mulchSkipped,
			mulchAppended: state.mulchAppended,
			seedsClosed: state.seedsClosed,
			seedsCreated: state.seedsCreated,
			seedIdClosed: state.seedIdClosed,
			seedsCommitted: state.seedsCommitted,
			plotEventsAppended: state.plotEventsAppended,
			plotsUpdated: state.plotsUpdated,
			plotEventsMirrored: state.plotEventsMirrored,
			plotCommitted: state.plotCommitted,
			branchPushed: state.branchPushed,
			commitsAhead: state.commitsAhead,
			prUrl: state.prUrl,
			previewState: state.previewLaunchState,
			previewPort: state.previewLaunchPort,
			previewUrl: state.previewUrl,
			autoPlanRunCreated: state.autoPlanRunCreated,
			autoPlanRunId: state.autoPlanRunId,
			workspaceDestroyed,
			errored: errors.length > 0,
		},
		"reap completed",
	);

	return {
		state: finalState,
		failureReason,
		mulchUpdated: state.mulchUpdated,
		mulchSkipped: state.mulchSkipped,
		mulchAppended: state.mulchAppended,
		seedsClosed: state.seedsClosed,
		seedsCreated: state.seedsCreated,
		seedIdClosed: state.seedIdClosed,
		plotEventsAppended: state.plotEventsAppended,
		plotsUpdated: state.plotsUpdated,
		plotEventsMirrored: state.plotEventsMirrored,
		plotCommitted: state.plotCommitted,
		seedsCommitted: state.seedsCommitted,
		branchPushed: state.branchPushed,
		commitsAhead: state.commitsAhead,
		prUrl: state.prUrl,
		previewState: state.previewLaunchState,
		previewPort: state.previewLaunchPort,
		previewUrl: state.previewUrl,
		autoPlanRunCreated: state.autoPlanRunCreated,
		autoPlanRunId: state.autoPlanRunId,
		autoPlanRunPlanId: state.autoPlanRunPlanId,
		workspaceDestroyed,
		errors,
		alreadyTerminal: false,
	};
}

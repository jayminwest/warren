import type { EventRow, RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import type { RunHandle, RuntimeProvider, WorkspaceInfo } from "../../runtime/contract.ts";
import { bindBridgeLogger } from "../stream/index.ts";
import { runWorkspaceDestroy } from "./destroy.ts";
import { createPipelineState, runReapPipeline } from "./pipeline.ts";
import { detectTerminalProviderError } from "./provider-error.ts";
import { inferFailureReason, isTerminal, transitionToTerminal } from "./state.ts";
import type { ReapRunInput, ReapRunResult, ReapStep, ReapStepError } from "./types.ts";
import { buildAlreadyTerminalResult, createSeqAllocator, defaultExec, defaultFs } from "./util.ts";

export async function reapRun(input: ReapRunInput): Promise<ReapRunResult> {
	const fs = input.fs ?? defaultFs;
	const exec = input.exec ?? defaultExec;
	const now = input.now ?? (() => new Date());
	// Runtime-provider seam (warren-1f56). The workspace-dependent half of reap
	// (finalize) + the sandbox teardown (terminate) + workspace resolution route
	// through this. REQUIRED since warren-e24d: reap no longer builds a fallback
	// burrow-backed provider, so it holds no burrow client of its own — the boot
	// wiring (and tests) construct the provider and thread it in.
	const provider: RuntimeProvider = input.runtimeProvider;

	const run = await input.repos.runs.require(input.runId);
	const log = bindBridgeLogger(input.logger, { run_id: run.id }); // warren-9f06: bind run_id once
	if (isTerminal(run.state)) {
		log.info({ event: "reap.skipped", state: run.state }, "reap skipped: run already terminal");
		return buildAlreadyTerminalResult(run);
	}

	// State on entry is the discriminator: still `queued` means the bridge
	// never claimed it (no events flowed from burrow) — "never started" (warren-5e53).
	const stateOnEntry = run.state;

	// warren-edc3: a terminal provider error (the agent's final model turn
	// ended with `stopReason === "error"` + a non-empty `errorMessage`, e.g.
	// Anthropic "credit balance too low" 400) flips an otherwise-`succeeded`
	// run to `failed`. Burrow sees the agent exit 0 and marks the run
	// succeeded, and the in-stream terminal detect (warren-e281 / pl-5516)
	// keys off the `agent_end` envelope, so the error signal on the per-turn
	// `turn_end` envelope slips through. This reap-time scan of the
	// persisted event log is the safety net; the provider message is
	// surfaced on the `reap.provider_error` event.
	const providerError = await detectTerminalProviderError(input.repos, run.id);
	const providerErrorMessage = providerError?.message ?? null;
	const failedFromProviderError = providerError !== null && input.outcome !== "cancelled";
	// The success pipeline gates PR-open / seed-close / preview / auto-dispatch
	// on `outcome === "succeeded"`, so thread the overridden outcome in so a
	// provider-error run skips them (no bookkeeping-only PR, no seed close,
	// no plan-run advance) — same posture as a normal bridge-failed run.
	const pipelineInput: ReapRunInput = failedFromProviderError
		? { ...input, outcome: "failed" }
		: input;

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
	// Fold a finalize failed-stage into `errors[]` WITHOUT re-emitting — the
	// matching `reap_failed` event already rode `FinalizeResult.events` and was
	// re-emitted by the pipeline (warren-1f56).
	const recordError = (step: ReapStep, message: string): void => {
		errors.push({ step, message });
		log.error({ event: "reap.step_failed", step, err: message }, "reap step failed");
	};

	const state = createPipelineState();

	let workspacePath: string | null = null;
	let branch: string | null = null;
	// warren-e9e1: resolve the workspace path + branch through the provider seam,
	// not a direct `burrows.get`. LocalProvider returns the live burrow worktree
	// path + branch (byte-identical to reap's old inline lookup); K8sProvider
	// returns `{ workspacePath: null, branch }` — the pod's `/workspace` is
	// host-unreachable, so there is no host path, but a succeeded K8s run must
	// still reach the pipeline + `finalize` (which runs in-pod). `resolved`
	// staying null means resolution FAILED (a live burrow 404 / API error); the
	// pipeline is skipped and `workspace_lookup` is recorded, exactly as before.
	let resolved: WorkspaceInfo | null = null;
	if (run.burrowId === null) {
		await fail("workspace_lookup", new Error("run has no burrow_id; nothing to reap from"));
	} else {
		try {
			resolved = await provider.workspaceInfo({
				runId: run.id,
				sandboxId: run.burrowId,
				providerRunId: run.burrowRunId ?? "",
			});
			workspacePath = resolved.workspacePath;
			branch = resolved.branch;
		} catch (err) {
			await fail("workspace_lookup", err);
		}
	}
	// Base branch for the empty-push count comes from the project row, not
	// burrow (which doesn't expose baseBranch at the top level). For V1 the
	// primary flow always carves the workspace branch off
	// `project.defaultBranch`, the correct ref for `rev-list --count`.
	const baseBranch: string | null = project?.defaultBranch ?? null;

	if (stateOnEntry === "queued" && resolved !== null && project !== null) {
		await emit("reap.never_started_skip", { message: "agent never ran; skipping pipeline" });
	} else if (stateOnEntry !== "queued" && resolved !== null && project !== null) {
		await runReapPipeline(
			{
				input: pipelineInput,
				run,
				project,
				workspacePath,
				branch,
				baseBranch,
				...(input.previewSidecars !== undefined ? { previewSidecars: input.previewSidecars } : {}),
				provider,
				fs,
				exec,
				now,
				log,
				emit,
				fail,
				recordError,
			},
			state,
		);
	} else if (resolved !== null && project === null) {
		await emit("reap.orphaned", {
			projectId: run.projectId,
			message: "project was deleted; skipping mulch merge, seeds close, and branch push",
		});
	}

	// warren-72b9: `droppedCommit` flips an otherwise-succeeded run to
	// `failed`/`dropped_commit` so it can't masquerade as success.
	// warren-edc3: a terminal provider error does the same — and blocks the
	// bookkeeping-only PR / seed close / plan-run advance that would
	// otherwise ship a no-code PR and discard the agent's uncommitted edits.
	// warren-495d: a finalize that timed out / failed before the branch push
	// completed leaves the agent's commits unpushed — flip an otherwise-
	// succeeded run to `failed`/`finalize_failed` so it can't report success
	// while its work sits only on the (soon-to-be-destroyed) workspace.
	const finalizeFailed = state.finalizeFailed && input.outcome === "succeeded";
	const effectiveOutcome: RunTerminalState =
		state.droppedCommit || failedFromProviderError || finalizeFailed ? "failed" : input.outcome;

	if (failedFromProviderError) {
		await emit("reap.provider_error", { message: providerErrorMessage });
	}

	let failureReason: RunFailureReason | null = null;
	if (state.droppedCommit) {
		failureReason = "dropped_commit";
	} else if (failedFromProviderError) {
		failureReason = "provider_error";
	} else if (finalizeFailed) {
		failureReason = "finalize_failed";
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
		providerError: failedFromProviderError ? providerErrorMessage : null,
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
		branchPushed: state.branchPushed,
		commitsAhead: state.commitsAhead,
		// warren-89b0: distinguish a deliberate no-op (succeeded, non-alarming)
		// from a dropped commit (failed) for operators reading the terminal event.
		noChanges: state.noChanges,
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
	// Route the sandbox teardown through the provider seam (warren-1f56). The
	// `terminate` closure is null when the run has no burrow or reap never
	// resolved the worker — the same skip the old `workerClient === null` gate had.
	const workspaceHandle: RunHandle | null =
		run.burrowId !== null
			? { runId: run.id, sandboxId: run.burrowId, providerRunId: run.burrowRunId ?? "" }
			: null;
	const terminate = workspaceHandle !== null ? () => provider.terminate(workspaceHandle) : null;
	const workspaceDestroyed = await runWorkspaceDestroy({
		run,
		previewLaunchState: state.previewLaunchState,
		// warren-495d: preserve the workspace when the branch push never completed
		// — the agent's commits live only here, so destroying it would silently
		// lose them. The eviction/GC path can reclaim it later once recovered.
		branchPushFailed: state.finalizeFailed,
		terminate,
		emit,
		fail: (step, err) => fail(step, err),
	});

	if (input.broker !== undefined) input.broker.close(run.id);

	log.info(
		{
			event: "reap.completed",
			state: finalState,
			failureReason,
			providerError: failedFromProviderError ? providerErrorMessage : null,
			mulchUpdated: state.mulchUpdated,
			mulchSkipped: state.mulchSkipped,
			mulchAppended: state.mulchAppended,
			seedsClosed: state.seedsClosed,
			seedsCreated: state.seedsCreated,
			seedIdClosed: state.seedIdClosed,
			seedsCommitted: state.seedsCommitted,
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
		providerError: failedFromProviderError ? providerErrorMessage : null,
		mulchUpdated: state.mulchUpdated,
		mulchSkipped: state.mulchSkipped,
		mulchAppended: state.mulchAppended,
		seedsClosed: state.seedsClosed,
		seedsCreated: state.seedsCreated,
		seedIdClosed: state.seedIdClosed,
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

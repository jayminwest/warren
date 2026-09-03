import type { EventRow, RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import type { RunHandle, RuntimeProvider, WorkspaceInfo } from "../../runtime/contract.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import { lifecycleBus } from "../lifecycle-bus.ts";
import { isInfraLostRunFailure } from "../retry/infra-lost-retry.ts";
import { bindBridgeLogger } from "../stream/index.ts";
import { runWorkspaceDestroy } from "./destroy.ts";
import { createPipelineState, runReapPipeline } from "./pipeline.ts";
import { detectTerminalProviderError, providerErrorEventPayload } from "./provider-error.ts";
import { salvageWorkspace, type WorkspaceSalvageOutcome } from "./salvage.ts";
import {
	detectSpawnExecFailure,
	inferFailureReason,
	isTerminal,
	transitionToTerminal,
} from "./state.ts";
import type { ReapRunInput, ReapRunResult, ReapStep, ReapStepError } from "./types.ts";
import { buildAlreadyTerminalResult, createSeqAllocator, defaultExec, defaultFs } from "./util.ts";

export async function reapRun(input: ReapRunInput): Promise<ReapRunResult> {
	const fs = input.fs ?? defaultFs;
	const exec = input.exec ?? defaultExec;
	const now = input.now ?? (() => new Date());
	// RuntimeProvider seam (warren-1f56/e24d): finalize + terminate + workspace.
	const provider: RuntimeProvider = input.runtimeProvider;

	const run = await input.repos.runs.require(input.runId);
	const log = bindBridgeLogger(input.logger, { run_id: run.id }); // warren-9f06: bind run_id once
	if (isTerminal(run.state)) {
		log.info({ event: "reap.skipped", state: run.state }, "reap skipped: run already terminal");
		return buildAlreadyTerminalResult(run);
	}

	// warren-7116: runtime-terminal edge (before any reap work) — first-write-wins.
	if (run.startedAt !== null) {
		await input.repos.runs.markAgentEnded(run.id, now());
	}

	// State on entry is the discriminator: still `queued` means the bridge
	// never claimed it (no events flowed from burrow) — "never started" (warren-5e53).
	const stateOnEntry = run.state;

	// warren-edc3: a terminal provider error (final model turn ended with
	// `stopReason === "error"` + a non-empty `errorMessage`, e.g. Anthropic
	// "credit balance too low" 400) flips an otherwise-`succeeded` run to
	// `failed`. The in-stream terminal detect (warren-e281 / pl-5516) keys off
	// the `agent_end` envelope, so the per-turn `turn_end` error signal slips
	// through; this reap-time scan of the persisted event log is the safety
	// net. warren-4001: the run row's declared provider/model ride as the
	// fallback so an opaque harness message still names the pair.
	const providerError = await detectTerminalProviderError(input.repos, run.id, {
		fallbackProvider: run.provider,
		fallbackModel: run.model,
	});
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
			sandboxEventSeq: seq.next(),
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
	if (run.sandboxId === null) {
		await fail("workspace_lookup", new Error("run has no sandbox_id; nothing to reap from"));
	} else {
		try {
			resolved = await provider.workspaceInfo({
				runId: run.id,
				sandboxId: run.sandboxId,
				providerRunId: run.sandboxRunId ?? "",
			});
			workspacePath = resolved.workspacePath;
			branch = resolved.branch;
		} catch (err) {
			await fail("workspace_lookup", err);
		}
	}
	// Base branch for the empty-push count comes from the run's frozen clone
	// ref (warren-8cbf: the workspace was cut from it, so it is the correct
	// ref for `rev-list --count` and the downstream PR base), falling back to
	// the project row (burrow doesn't expose baseBranch at the top level). A
	// run dispatched without a ref behaves exactly as before: defaultBranch.
	const baseBranch: string | null = run.ref ?? project?.defaultBranch ?? null;

	// warren-4e74: observe-only `pre_reap` — reap is about to touch the
	// workspace. A no-op unless a bus is installed with a subscriber; fired
	// before the finalize pipeline so a consumer (e.g. the mulch/seeds
	// mirror eviction, warren-df3e) sees the run's intended outcome.
	lifecycleBus()?.emitPreReap({
		runId: run.id,
		projectId: run.projectId ?? "",
		outcome: pipelineInput.outcome,
	});

	// warren-4e2a: a spawn-exec failure produced zero agent work — skip the
	// seeds commit + branch push (same posture as never_started; the push
	// would pollute the repo). `inferFailureReason` classifies it below.
	const spawnExecFailed =
		stateOnEntry !== "queued" &&
		input.outcome === "failed" &&
		(await detectSpawnExecFailure(input.repos, run.id));

	if (stateOnEntry === "queued" && resolved !== null && project !== null) {
		await emit("reap.never_started_skip", { message: "agent never ran; skipping pipeline" });
	} else if (spawnExecFailed && resolved !== null && project !== null) {
		await emit("reap.spawn_failed_skip", {
			message: "agent process could not be spawned; skipping seeds commit and branch push",
		});
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

	// Flip succeeded→failed: dropped_commit (72b9), ref-dispatch no_changes (ba08;
	// fresh-branch no-ops stay succeeded/89b0), provider_error (edc3), finalize_failed (495d).
	const finalizeFailed = state.finalizeFailed && input.outcome === "succeeded";
	const noChangesFailure =
		state.noChanges &&
		(run.ref !== null || run.targetBranch !== null) &&
		input.outcome === "succeeded";
	const effectiveOutcome: RunTerminalState =
		state.droppedCommit || noChangesFailure || failedFromProviderError || finalizeFailed
			? "failed"
			: input.outcome;

	if (failedFromProviderError && providerError !== null) {
		// warren-4001: structured provider-error surface — the payload names
		// provider/model/status so a degraded upstream pool is diagnosable
		// from the event stream alone.
		await emit("reap.provider_error", providerErrorEventPayload(providerError));
	}

	let failureReason: RunFailureReason | null = null;
	if (state.droppedCommit) {
		failureReason = "dropped_commit";
	} else if (noChangesFailure) {
		failureReason = "no_changes";
	} else if (failedFromProviderError) {
		failureReason = "provider_error";
	} else if (finalizeFailed) {
		// warren-5ea1: split the two finalize failure classes. `finalize_failed`
		// is a pod-computed result whose push stage failed (e.g. a rejected
		// push); `finalize_unposted` is a warren-synthesized result — the pod
		// reached a terminal phase / vanished / timed out without posting
		// anything, so the workspace died with it and salvage is the only
		// recovery path.
		// warren-b68d: a pod-computed result whose push the REMOTE refused on
		// policy grounds narrows one step further. `finalize_unposted` still wins
		// the tie: no push was ever attempted, so a rejection cannot be live. The
		// remediation itself already reached the operator — finalize appended
		// `reap.push_rejected` and the pipeline replayed it.
		if (state.finalizeUnposted !== null) {
			failureReason = "finalize_unposted";
		} else {
			failureReason = state.pushRejectedByPolicy ? "push_rejected_policy" : "finalize_failed";
		}
	} else if (effectiveOutcome === "failed") {
		failureReason =
			input.failureReason ?? (await inferFailureReason(input.repos, run.id, stateOnEntry));
	}

	// warren-cd3b: salvage-before-destroy. The finalize branch push never
	// landed, so the agent's commits exist ONLY on this workspace — capture
	// them (rescue-ref push, then a durable git bundle) BEFORE the destroy
	// sub-step decides the workspace's fate. LocalProvider only: under k8s
	// `workspacePath` is null (the pod's emptyDir is host-unreachable) and the
	// pod runs its own salvage + POSTs it to `/runs/:id/salvage`. A successful
	// capture also lifts the destroy skip below: the work is safe, so the
	// workspace no longer needs preserving.
	let salvage: WorkspaceSalvageOutcome | null = null;
	// warren-985e: the pod-side surfacing arm also covers a provider_error
	// failure — that run's finalize SUCCEEDED (it pushed the zero-commit
	// branch), so `finalizeFailed` never fires, but the pod's
	// `empty_push_dirty` salvage window may still have captured the
	// uncommitted work and stamped the row before posting its result.
	if ((state.finalizeFailed || failedFromProviderError) && workspacePath === null) {
		// warren-5ea1 (k8s): the control plane cannot reach the pod's emptyDir,
		// so reap cannot capture anything itself — but the pod may have POSTed a
		// self-salvage (`/runs/:id/salvage` intake stamps the run row) before
		// exiting. Surface whatever landed so the terminal record names the
		// recovery path at a glance, and let the destroy proceed when the work
		// is already durable elsewhere (the intake's `reap.workspace_salvaged`
		// event carries the operator-visible detail; re-fetch the row since the
		// stamp can land after reap's initial read).
		const fresh = await input.repos.runs.require(run.id);
		if (fresh.salvageRef !== null || fresh.salvagePath !== null) {
			salvage = { rescueRef: fresh.salvageRef, bundlePath: fresh.salvagePath, errors: [] };
			await emit("reap.workspace_salvage_recorded", {
				source: "pod",
				rescueRef: fresh.salvageRef,
				bundlePath: fresh.salvagePath,
			});
		} else {
			await emit("reap.workspace_salvage_failed", {
				errors: [
					failedFromProviderError && !state.finalizeFailed
						? "run failed with provider_error and the pod posted no salvage bundle; any uncommitted work is unrecoverable"
						: "pod reached a terminal phase without posting a finalize result or a salvage bundle; committed work is unrecoverable",
				],
			});
		}
	}
	if (state.finalizeFailed && workspacePath !== null) {
		// warren-4e1c: mint the rescue-push credential immediately before the
		// salvage spawn (forge-contract.md §4 — minted, never held). A mint
		// failure is recorded and degrades to an anonymous push (which fails
		// closed on a private repo) rather than skipping the salvage.
		let gitCredential: GitSpawnCredential | undefined;
		if (input.forge !== undefined && project !== null) {
			try {
				gitCredential = await mintGitCredential(input.forge, project.gitUrl);
			} catch (err) {
				await fail("branch_push", err);
			}
		}
		salvage = await salvageWorkspace({
			runId: run.id,
			workspacePath,
			baseBranch,
			...(input.salvageDir !== undefined ? { salvageDir: input.salvageDir } : {}),
			...(gitCredential !== undefined ? { gitCredential } : {}),
			exec,
			fs,
		});
		if (salvage.rescueRef !== null || salvage.bundlePath !== null) {
			try {
				await input.repos.runs.setSalvage(run.id, {
					rescueRef: salvage.rescueRef,
					bundlePath: salvage.bundlePath,
				});
			} catch (err) {
				// The row write is bookkeeping; the capture itself is the artifact.
				log.warn(
					{
						event: "reap.salvage_stamp_failed",
						err: err instanceof Error ? err.message : String(err),
					},
					"salvage captured but the run row could not be stamped",
				);
			}
			await emit("reap.workspace_salvaged", {
				rescueRef: salvage.rescueRef,
				bundlePath: salvage.bundlePath,
			});
		} else {
			await emit("reap.workspace_salvage_failed", { errors: salvage.errors });
		}
	}
	// The destroy skip (warren-495d) now gates on a FAILED salvage too: once
	// the work is captured, preserving the workspace buys nothing.
	const workspacePreserved = state.finalizeFailed && salvage === null;
	const salvageFailed =
		salvage !== null && salvage.rescueRef === null && salvage.bundlePath === null;

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
			committed: state.seedsCommitted,
		},
		branchPushed: state.branchPushed,
		commitsAhead: state.commitsAhead,
		salvage: {
			rescueRef: salvage?.rescueRef ?? null,
			bundlePath: salvage?.bundlePath ?? null,
		},
		// warren-89b0/ba08: noChanges flag (run state may still be failed on ref-dispatch).
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
		run.sandboxId !== null
			? { runId: run.id, sandboxId: run.sandboxId, providerRunId: run.sandboxRunId ?? "" }
			: null;
	const terminate = workspaceHandle !== null ? () => provider.terminate(workspaceHandle) : null;
	const workspaceDestroyed = await runWorkspaceDestroy({
		run,
		previewLaunchState: state.previewLaunchState,
		// warren-495d + warren-cd3b: preserve the workspace when the branch push
		// never completed AND salvage could not capture the work (k8s — the pod
		// self-salvages instead — or a local salvage that failed outright). Once
		// salvage lands, destroy proceeds: the work is durable elsewhere.
		branchPushFailed: workspacePreserved || salvageFailed,
		terminate,
		emit,
		fail: (step, err) => fail(step, err),
	});

	// warren-9b77: persist the destruction warren-side so the fallback GC
	// sweep and the `/readyz` stale-workspace diagnostic never re-strand
	// this workspace. Best-effort like the destroy itself — a bookkeeping
	// failure surfaces as an event and the GC simply reclaims it later.
	if (workspaceDestroyed && run.sandboxId !== null) {
		try {
			await input.repos.runs.clearBurrowIdForWorkspace(run.sandboxId);
		} catch (err) {
			await emit("reap.workspace_destroy_record_failed", {
				sandboxId: run.sandboxId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// warren-4e74: observe-only lifecycle emits, after the terminal
	// transition and workspace teardown. `branch_pushed` fires only when
	// finalize actually pushed commits; `post_reap` always fires so a
	// consumer sees the settled summary (the hook warren-df3e subscribes
	// to). No-op unless a bus is installed with a subscriber.
	const bus = lifecycleBus();
	if (bus !== undefined) {
		if (state.branchPushed && branch !== null) {
			bus.emitBranchPushed({
				runId: run.id,
				branch,
				baseBranch,
				commitsAhead: state.commitsAhead,
			});
		}
		bus.emitPostReap({
			runId: run.id,
			projectId: run.projectId ?? "",
			outcome: effectiveOutcome,
			branchPushed: state.branchPushed,
			commitsAhead: state.commitsAhead,
			prUrl: state.prUrl,
		});
	}

	// warren-4af7: an infra-lost terminalization earns ONE automatic retry —
	// a fresh run linked via `runs.retry_of`, dispatched by the boot-wired
	// hook after the workspace is torn down. Plan-run children stand down
	// inside the hook (the coordinator's child retry owns them). Fire-and-log:
	// a hook failure lands as `run.retry_failed` and never fails the reap.
	if (
		finalState === "failed" &&
		isInfraLostRunFailure(failureReason) &&
		input.onInfraLostRun !== undefined
	) {
		try {
			await input.onInfraLostRun(run.id);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await emit("run.retry_failed", { error: message });
			log.error({ event: "run.retry_failed", err: message }, "infra-lost run retry failed");
		}
	}

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
		salvageRescueRef: salvage?.rescueRef ?? null,
		salvagePath: salvage?.bundlePath ?? null,
		errors,
		alreadyTerminal: false,
	};
}

/**
 * Per-PlanRun decision loop (pl-a258 step 5 / warren-2623).
 *
 * `advancePlanRun` is the load-bearing state machine. One call examines
 * the current PlanRun, decides exactly one of:
 *
 *   - dispatch the next pending child
 *   - wait for the in-flight child's run to finish
 *   - wait for the in-flight child's PR to merge
 *   - advance: previous child merged, dispatch the next (or succeed)
 *   - fail the plan (terminal child run, PR closed unmerged, dispatch error)
 *   - succeed the plan (every child reached merged / skipped)
 *   - noop (something unexpected — return diagnostic, don't crash)
 *
 * The state machine is described in warren-2623 step (a)/(b)/(c). Resume
 * semantics (warren-fcc9): a seed that's already `closed` at dispatch
 * time gets flipped to `skipped` without spawning a run, so re-dispatching
 * the same plan id picks up where the prior PlanRun left off.
 *
 * Trivial-merge (mx-fd8619): when the child run terminal-succeeds with
 * `run.prUrl === null` AND reap emitted a `reap.empty_push` system event
 * (commitsAhead === 0), the coordinator advances directly to `merged`
 * without GitHub polling. Dropped commits (warren-72b9) reap `failed` first.
 *
 * Events fire via `emit(runId, kind, payload)` on the most recently
 * dispatched child run; callers wire it to `repos.events.append`
 * (mirrors the scheduler's `trigger.*` system events in
 * src/triggers/tick.ts).
 *
 * The coordinator itself never throws — every failure path is encoded
 * in the AdvanceResult union. The tick wrapper (tick.ts) still wraps
 * calls in try/catch so a programmer error in the repo or spawn seam
 * can't tear down the loop.
 */

import { formatError } from "../core/errors.ts";
import { renderPlanRunPrompt } from "../core/plan-run-prompt.ts";
import { type Issue, IssueNotFoundError } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunChildRow, PlanRunChildState, PlanRunRow } from "../db/schema.ts";
import type { PrMergeChecker } from "../runs/pr-merge.ts";
import { handleInFlight } from "./in-flight.ts";
import { type CoordinatorReopenPrFn, checkParentRunMerged } from "./merge-gate.ts";

export type { CoordinatorReopenPrFn } from "./merge-gate.ts";

export type CoordinatorRepos = Pick<Repos, "planRuns" | "runs" | "events">;

export type CoordinatorGetIssueFn = (projectId: string, issueId: string) => Promise<Issue>;

export interface CoordinatorSpawnInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly prompt: string;
}

export interface CoordinatorSpawnResult {
	readonly runId: string;
}

export type CoordinatorSpawnFn = (input: CoordinatorSpawnInput) => Promise<CoordinatorSpawnResult>;

export type CoordinatorEmitFn = (
	runId: string,
	kind: PlanRunEventKind,
	payload: Record<string, unknown>,
) => Promise<void>;

/**
 * Optional host-side child-seed close hook (warren-3806). Called the instant
 * a plan-run child transitions to `merged` (both the trivial-merge and
 * PR-poll paths). The implementation deterministically closes the child's
 * seed on the project's default branch using WARREN_BOT_IDENTITY, so seed
 * closure never depends on agent initiative. Best-effort: the implementation
 * owns its own error handling/logging and always resolves, so a close failure
 * never blocks the plan from advancing. Default (tests / unwired) is a no-op,
 * matching the pre-warren-3806 baseline.
 */
export type CoordinatorCloseChildSeedFn = (input: {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
}) => Promise<void>;

export const PLAN_RUN_EVENT_KINDS = [
	"plan_run.advanced",
	"plan_run.dispatched",
	"plan_run.waiting_for_merge",
	"plan_run.merged",
	"plan_run.failed",
	"plan_run.succeeded",
	"plan_run.waiting_for_pr_reopen",
	"plan_run.child_retried",
	"plan_run.resumed",
] as const;
export type PlanRunEventKind = (typeof PLAN_RUN_EVENT_KINDS)[number];

export type AdvanceResult =
	| { readonly kind: "dispatched"; readonly childRunId: string }
	| { readonly kind: "waiting_for_run" }
	| { readonly kind: "waiting_for_merge" }
	| { readonly kind: "waiting_for_parent_merge" }
	| {
			readonly kind: "advanced";
			readonly mergedChildSeq: number;
			readonly dispatchedChildSeq?: number;
	  }
	| { readonly kind: "plan_failed"; readonly failedSeq: number; readonly reason: string }
	| { readonly kind: "plan_succeeded" }
	| { readonly kind: "noop"; readonly reason: string };

export interface AdvancePlanRunInput {
	readonly planRun: PlanRunRow;
	readonly repos: CoordinatorRepos;
	readonly getIssue: CoordinatorGetIssueFn;
	readonly checkPrMerged: PrMergeChecker;
	readonly spawn: CoordinatorSpawnFn;
	readonly emit: CoordinatorEmitFn;
	/** warren-3806: host-side seed close fired when a child transitions to merged. */
	readonly closeChildSeed?: CoordinatorCloseChildSeedFn;
	/** warren-3937: merge-wait budget (ms); defaults to {@link DEFAULT_MERGE_TIMEOUT_MS}, 0 disables. */
	readonly mergeTimeoutMs?: number;
	/** warren-22de: PR-(re)open seam. See {@link CoordinatorReopenPrFn}. */
	readonly reopenPr?: CoordinatorReopenPrFn;
	readonly now?: () => Date;
}

/** Default merge-wait budget: 30 minutes (warren-3937). */
export const DEFAULT_MERGE_TIMEOUT_MS = 30 * 60 * 1000;

const IN_FLIGHT_STATES: readonly PlanRunChildState[] = ["dispatched", "running", "pr_open"];

export async function advancePlanRun(input: AdvancePlanRunInput): Promise<AdvanceResult> {
	const nowFn = input.now ?? (() => new Date());
	const mergeTimeoutMs = input.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS;
	let planRun = input.planRun;

	// (a) Queued → running.
	if (planRun.state === "queued") {
		const startedAt = nowFn().toISOString();
		planRun = await input.repos.planRuns.transitionTo(planRun.id, "running", { startedAt });
	}

	// warren-d9a2: gate on parent run's PR being merged before dispatching
	// the first child. Auto-plan-runs carry parentRunId — the parent's
	// branch has the seeds state the children need on main.
	if (planRun.parentRunId !== null) {
		const gateResult = await checkParentRunMerged({
			planRun,
			repos: input.repos,
			checkPrMerged: input.checkPrMerged,
			emit: input.emit,
			mergeTimeoutMs,
			now: nowFn,
		});
		if (gateResult !== null) return gateResult;
	}

	let mergedChildSeq: number | undefined;

	// Loop until we hit a terminal/waiting decision. Each iteration reloads
	// children so a merge/skip can fall through to the dispatch arm.
	for (;;) {
		const children = await input.repos.planRuns.listChildren(planRun.id);
		const inFlight = children.find((c) => IN_FLIGHT_STATES.includes(c.state));

		if (inFlight !== undefined) {
			const decision = await handleInFlight({
				planRun,
				child: inFlight,
				repos: input.repos,
				checkPrMerged: input.checkPrMerged,
				emit: input.emit,
				getIssue: input.getIssue,
				mergeTimeoutMs,
				now: nowFn,
				reopenPr: input.reopenPr,
				spawn: input.spawn,
				...(input.closeChildSeed !== undefined ? { closeChildSeed: input.closeChildSeed } : {}),
			});
			if (decision.kind === "merged") {
				mergedChildSeq = inFlight.seq;
				continue;
			}
			if (decision.kind === "result") {
				return decision.result;
			}
		}

		// (c) Pick the next pending child.
		const next = await input.repos.planRuns.pickNextPending(planRun.id);
		if (next === null) {
			// All children terminal — succeed the plan.
			const endedAt = nowFn().toISOString();
			await input.repos.planRuns.transitionTo(planRun.id, "succeeded", { endedAt });
			const anchor = mostRecentDispatchedRunId(children);
			if (anchor !== null) {
				await input.emit(anchor, "plan_run.succeeded", { planRunId: planRun.id });
			}
			return { kind: "plan_succeeded" };
		}

		// Resume semantics — closed child issue → skip without dispatch.
		let issue: Issue;
		try {
			issue = await input.getIssue(planRun.projectId, next.seedId);
		} catch (err) {
			// warren-0fed: a definitive "issue not found" is terminal — the
			// plan references an id that doesn't resolve (planned-but-never-
			// created, or only on an unmerged branch), so retrying forever
			// just spams plan_run.noop. Fail the child + plan-run. Any other
			// (transient: timeout / lock / malformed) tracker failure stays a
			// retryable noop so a hung tracker can't kill healthy runs.
			if (err instanceof IssueNotFoundError) {
				const reason = `child_seed_not_found:${next.seedId}`;
				const endedAt = nowFn().toISOString();
				await input.repos.planRuns.updateChild({
					planRunId: planRun.id,
					seq: next.seq,
					patch: { state: "failed", failureReason: reason, endedAt },
					now: nowFn(),
				});
				await input.repos.planRuns.transitionTo(planRun.id, "failed", {
					endedAt,
					failureReason: reason,
				});
				const anchor = mostRecentDispatchedRunId(children);
				if (anchor !== null) {
					await input.emit(anchor, "plan_run.failed", {
						planRunId: planRun.id,
						failedSeq: next.seq,
						reason,
					});
				}
				return { kind: "plan_failed", failedSeq: next.seq, reason };
			}
			return {
				kind: "noop",
				reason: `show_seed_failed:${formatError(err)}`,
			};
		}
		if (issue.status === "closed") {
			await input.repos.planRuns.updateChild({
				planRunId: planRun.id,
				seq: next.seq,
				patch: { state: "skipped", endedAt: nowFn().toISOString() },
				now: nowFn(),
			});
			continue;
		}

		// Dispatch the next child; legacy {seed_id}-only template render.
		// Every occurrence is substituted (warren-b3be).
		const prompt = renderPlanRunPrompt(planRun.promptTemplate, next.seedId);
		let spawnResult: CoordinatorSpawnResult;
		try {
			spawnResult = await input.spawn({ planRun, child: next, prompt });
		} catch (err) {
			const reason = `dispatch_failed:${formatError(err)}`;
			const endedAt = nowFn().toISOString();
			await input.repos.planRuns.updateChild({
				planRunId: planRun.id,
				seq: next.seq,
				patch: { state: "failed", failureReason: reason, endedAt },
				now: nowFn(),
			});
			await input.repos.planRuns.transitionTo(planRun.id, "failed", {
				endedAt,
				failureReason: reason,
			});
			const anchor = mostRecentDispatchedRunId(children);
			if (anchor !== null) {
				await input.emit(anchor, "plan_run.failed", {
					planRunId: planRun.id,
					failedSeq: next.seq,
					reason,
				});
			}
			return { kind: "plan_failed", failedSeq: next.seq, reason };
		}

		await input.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: next.seq,
			patch: {
				runId: spawnResult.runId,
				state: "dispatched",
				startedAt: nowFn().toISOString(),
			},
			now: nowFn(),
		});
		await input.emit(spawnResult.runId, "plan_run.dispatched", {
			planRunId: planRun.id,
			seq: next.seq,
			seedId: next.seedId,
		});
		if (mergedChildSeq !== undefined) {
			await input.emit(spawnResult.runId, "plan_run.advanced", {
				planRunId: planRun.id,
				mergedChildSeq,
				dispatchedChildSeq: next.seq,
			});
			return {
				kind: "advanced",
				mergedChildSeq,
				dispatchedChildSeq: next.seq,
			};
		}
		return { kind: "dispatched", childRunId: spawnResult.runId };
	}
}

/* handleInFlight + execution helpers live in ./in-flight.ts (size budget). */

function mostRecentDispatchedRunId(children: readonly PlanRunChildRow[]): string | null {
	for (let i = children.length - 1; i >= 0; i -= 1) {
		const child = children[i];
		if (child !== undefined && child.runId !== null) return child.runId;
	}
	return null;
}

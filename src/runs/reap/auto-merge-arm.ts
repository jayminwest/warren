/**
 * The auto-merge ARM sub-step (warren-14d6, plan pl-92a3 step 6): the piece
 * that runs after reap opens (or resolves to) a pull request, asks the
 * step-5 policy whether that pull request may be armed, and — on `arm` —
 * calls `forge.armAutoMerge`. One module, two callers, no copies: the reap
 * PR-open sub-step (`pr-open.ts`) and the plan-run coordinator's reopen
 * seam (`src/server/main/plan-run-wiring.ts`) both route through
 * {@link runAutoMergeArm}, so a reopened child's PR arms exactly the way a
 * reaped one does (AGENTS.md "Single source of truth").
 *
 * The step emits exactly ONE event per invocation (design record §5):
 *
 *   - `reap.auto_merge_armed`      { prUrl, prNumber, method, outcome }
 *   - `reap.auto_merge_skipped`    { reason, paths? }
 *   - `reap.auto_merge_not_armed`  { reason, message }
 *
 * Hard invariants (docs/design/forge-auto-merge.md §4, warren-14d6):
 *
 *   - OFF IS SILENT. `projectAutoMerge` — the project's OWN `pr.autoMerge`
 *     block, resolved by the caller from the project config warren already
 *     loads — is the engagement gate. `undefined` returns before a single
 *     git read, forge call, or event, so deployments that never opted in
 *     keep byte-identical behavior and test expectations.
 *   - THE ARM NEVER FAILS A RUN. `runAutoMergeArm` cannot throw; an
 *     unexpected exception inside the step collapses to
 *     `reap.auto_merge_not_armed` with reason `unknown`. Nothing here
 *     writes run state or touches `failureReason` — the caller's terminal
 *     transition is untouchable from inside the step.
 *   - NO RETRY OF ITS OWN. The GitHub provider owns the bounded
 *     mergeability retry inside `armAutoMerge` (warren-d993), so the step
 *     adds at most that provider's budget to reap and never re-calls a
 *     refusal. Idempotence across a re-reap sweep comes from the forge:
 *     `already_armed` is success.
 *
 * Policy and diff inputs are fetched from the configured project remote into
 * an isolated repository and pinned to commit SHAs (warren-8908). Shared
 * worktree refs and Git configuration are agent-writable and never trusted.
 */

import { CI_FIXER_TRIGGER } from "../../ci-fixer/poller.ts";
import type { Forge, PullRequestRef, RepoRef } from "../../forge/contract.ts";
import type { AutoMergeConfig } from "../../warren-config/pr-config.ts";
import { decideAutoMerge } from "./auto-merge-policy.ts";
import { readAutoMergeSnapshot } from "./auto-merge-snapshot.ts";
import type { ReapExec } from "./types.ts";

export interface RunAutoMergeArmInput {
	/**
	 * The engagement gate: the project's OWN `pr.autoMerge` block, resolved
	 * by the caller (reap: threaded from the warren-config cache via the
	 * reap input; the reopen seam: `warrenConfigs.get`). `undefined` means
	 * the project never opted in — the step returns silently.
	 */
	readonly projectAutoMerge: AutoMergeConfig | undefined;
	/** The run's trigger — a CI-fixer run rides an existing armed PR head. */
	readonly run: { readonly id: string; readonly trigger?: string };
	readonly project: { readonly gitUrl: string; readonly localPath: string };
	readonly prUrl: string;
	readonly prNumber: number;
	/** The forge refs `pr_open` (or the reopen seam) just produced. */
	readonly repoRef: RepoRef;
	readonly prRef: PullRequestRef;
	/** The run's pushed branch (diff head). */
	readonly branch: string;
	/** The PR base ref — the policy source AND the diff base (§3.1). */
	readonly baseBranch: string;
	/** Retained for callers; all providers read the pushed remote snapshot. */
	readonly workspacePath: string | null;
	/** The boot-resolved forge; `capabilities.autoMergeArm` gates the call. */
	readonly forge: Forge;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
}

/**
 * Run the arm sub-step. Best-effort and total: it never throws, never
 * changes run state, and emits exactly one of the three §5 events — except
 * when the project never opted in, where it emits nothing at all.
 */
export async function runAutoMergeArm(input: RunAutoMergeArmInput): Promise<void> {
	// The engagement gate (§4): with `pr.autoMerge` absent the step never
	// runs — no git read, no forge call, no event.
	if (input.projectAutoMerge === undefined) return;
	try {
		await armOnce(input);
	} catch (err) {
		// The arm never throws into reap (§4): an unexpected exception is a
		// reportable not-armed outcome, never a run failure.
		await safeEmit(input, "reap.auto_merge_not_armed", {
			reason: "unknown",
			message: `unexpected error in the auto-merge arm step: ${
				err instanceof Error ? err.message : String(err)
			}`,
		});
	}
}

/** One arm attempt: resolve the policy inputs, decide, then arm or report. */
async function armOnce(input: RunAutoMergeArmInput): Promise<void> {
	const { config, changedPaths } = await readAutoMergeSnapshot(input);
	const decision = decideAutoMerge({
		config,
		forgeCanArm: input.forge.capabilities.autoMergeArm,
		changedPaths,
		ciFixerRun: input.run.trigger === CI_FIXER_TRIGGER,
	});
	if (decision.decision === "skip") {
		await safeEmit(input, "reap.auto_merge_skipped", {
			reason: decision.reason,
			...(decision.paths !== undefined ? { paths: decision.paths } : {}),
		});
		return;
	}
	const result = await input.forge.armAutoMerge(input.repoRef, input.prRef, {
		method: decision.method,
	});
	if (result.ok) {
		await safeEmit(input, "reap.auto_merge_armed", {
			prUrl: input.prUrl,
			prNumber: input.prNumber,
			method: decision.method,
			outcome: result.value.outcome,
		});
		return;
	}
	await safeEmit(input, "reap.auto_merge_not_armed", {
		reason: result.error.reason,
		message: result.error.message,
	});
}

/** Emit without ever letting an event-write failure escape the step. */
async function safeEmit(
	input: Pick<RunAutoMergeArmInput, "emit">,
	kind: string,
	payload: Record<string, unknown>,
): Promise<void> {
	try {
		await input.emit(kind, payload);
	} catch {
		// Best-effort by contract: a failed event append must not fail the run.
	}
}

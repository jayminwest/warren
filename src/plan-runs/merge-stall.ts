/**
 * Merge-stall warning for plan-run children (pl-92a3 step 7,
 * docs/design/forge-auto-merge.md §7).
 *
 * A plan-run child that sits in `waiting_for_merge` on a green PR with no
 * armed auto-merge used to die silently hours later at the merge deadline —
 * the trellis outage (§0 of the design record). This module closes that
 * observability hole regardless of who arms: once the child's PR has been
 * open past a grace period (same clock baseline as the merge timeout,
 * `mergeWaitBaseline`), the coordinator probes the PR's auto-merge state and
 * check rollup and emits a one-shot `plan_run.merge_stalled` warning. The
 * same diagnosis attaches to the `child_pr_merge_timeout` failure payload so
 * the terminal failure says why.
 *
 * False-alarm discipline (the §7 contract): an `unknown` auto-merge reading
 * or unavailable checks NEVER trigger the warning — a forge that cannot tell
 * (ADO, a PAT without the Checks API) stays silent rather than guessing.
 *
 * The probe never throws and adds forge calls only once the grace period has
 * elapsed (zero extra calls during the first minutes of a normal merge
 * wait), so it respects the rate-limit budget of the existing merge poll.
 */

import type { PlanRunChildRow, PlanRunRow } from "../db/schema.ts";
import type { Forge, PullRequestAutoMergeState } from "../forge/contract.ts";
import { resolvePollTarget } from "../runs/pr-merge.ts";
import type { CoordinatorEmitFn, CoordinatorRepos } from "./coordinator.ts";

/**
 * What the probe observed. `checksPassing: null` means the check rollup was
 * unavailable (capability false, forge error, non-open PR); `autoMerge:
 * null` means the PR state itself was unreadable. Both nulls suppress the
 * warning — an honest "cannot tell" never fires a false alarm.
 */
export interface MergeStallDiagnosis {
	readonly checksPassing: boolean | null;
	readonly autoMerge: PullRequestAutoMergeState | null;
}

/**
 * Best-effort probe of one PR's stall inputs. Never throws; a probe that
 * cannot answer returns nulls rather than guessing.
 */
export type MergeStallProbe = (prUrl: string) => Promise<MergeStallDiagnosis>;

/** Operator-facing hint carried on the `plan_run.merge_stalled` payload. */
export const MERGE_STALLED_HINT =
	"checks are passing but auto-merge is not armed — arm auto-merge " +
	"(pr.autoMerge or the repo workflow) or merge the PR before the merge timeout";

/**
 * Build the boot-wired probe from the Forge seam. Reuses the merge poll's
 * URL-target resolution, reads the PR state (auto-merge + head commit), and
 * consults the check rollup only when `capabilities.checkRuns` is true —
 * one `getPullRequest` plus at most one `listChecks` per probe, and the
 * coordinator calls the probe only once the grace period has elapsed.
 */
export function createMergeStallProbe(input: { readonly forge: Forge }): MergeStallProbe {
	return async (prUrl: string): Promise<MergeStallDiagnosis> => {
		const target = resolvePollTarget(input.forge, prUrl);
		if (target.kind === "unparseable") return { checksPassing: null, autoMerge: null };
		const state = await input.forge.getPullRequest(target.ref, target.pr);
		if (!state.ok) return { checksPassing: null, autoMerge: null };
		if (state.value.lifecycle !== "open") return { checksPassing: null, autoMerge: null };
		const autoMerge = state.value.autoMerge;
		if (!input.forge.capabilities.checkRuns) {
			return { checksPassing: null, autoMerge };
		}
		const checks = await input.forge.listChecks(target.ref, state.value.headCommit);
		if (!checks.ok) return { checksPassing: null, autoMerge };
		if (checks.value.conclusion === "unknown") {
			// No check runs at all — unavailable, not failing. The §7 contract
			// keeps an unavailable rollup at null so it never triggers the
			// warning (no false alarms on a PAT without the Checks API).
			return { checksPassing: null, autoMerge };
		}
		return { checksPassing: checks.value.conclusion === "passing", autoMerge };
	};
}

/**
 * Has this child run already carried a `plan_run.merge_stalled` event? The
 * same persisted-event scan shape as `hasEmptyPushEvent`, so the one-shot
 * guarantee survives a server restart: the warning is derived from the
 * durable event stream, never from process memory.
 */
export async function hasMergeStalledEvent(
	repos: CoordinatorRepos,
	runId: string,
): Promise<boolean> {
	const events = await repos.events.listByRun(runId);
	for (const ev of events) {
		if (ev.kind === "plan_run.merge_stalled") return true;
	}
	return false;
}

/** Milliseconds since `baseline`, or null when the baseline is unusable. */
function waitedMsSince(baseline: string | null, now: () => Date): number | null {
	if (baseline === null) return null;
	const started = Date.parse(baseline);
	if (Number.isNaN(started)) return null;
	return now().getTime() - started;
}

export interface MaybeWarnMergeStalledInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly runId: string;
	readonly prUrl: string;
	/** `mergeWaitBaseline` of the child run — the stall clock's zero. */
	readonly baseline: string | null;
	readonly probe: MergeStallProbe | undefined;
	/** Grace period in ms; 0 disables the warning. */
	readonly warningMs: number;
	readonly repos: CoordinatorRepos;
	readonly emit: CoordinatorEmitFn;
	readonly now: () => Date;
}

/**
 * Emit the one-shot `plan_run.merge_stalled` warning when the grace
 * condition holds: the PR has been open past the grace period, checks are
 * passing, and auto-merge reads `unarmed`. Everything else — checks pending
 * or failing, checks unavailable, `armed` or `unknown` auto-merge, a
 * prior warning on the persisted stream, the knob at 0, no probe wired —
 * stays silent. Never throws and never changes the child's state.
 */
export async function maybeWarnMergeStalled(input: MaybeWarnMergeStalledInput): Promise<void> {
	const { probe, warningMs, baseline, now } = input;
	if (warningMs <= 0) return;
	if (probe === undefined) return;
	const waitedMs = waitedMsSince(baseline, now);
	if (waitedMs === null || waitedMs < warningMs) return;
	if (await hasMergeStalledEvent(input.repos, input.runId)) return;
	const diagnosis = await probe(input.prUrl);
	if (diagnosis.checksPassing !== true || diagnosis.autoMerge !== "unarmed") return;
	await input.emit(input.runId, "plan_run.merge_stalled", {
		planRunId: input.planRun.id,
		seq: input.child.seq,
		seedId: input.child.seedId,
		prUrl: input.prUrl,
		checksPassing: diagnosis.checksPassing,
		autoMerge: diagnosis.autoMerge,
		waitedMs,
		hint: MERGE_STALLED_HINT,
	});
}

/**
 * Diagnosis fields for the `child_pr_merge_timeout` failure payload: what
 * the checks and the auto-merge state read at the deadline. Returns an
 * empty record when no probe is wired, so unwired callers keep their
 * existing payload byte-identical.
 */
export async function mergeTimeoutDiagnosis(
	probe: MergeStallProbe | undefined,
	prUrl: string,
): Promise<Record<string, unknown>> {
	if (probe === undefined) return {};
	const diagnosis = await probe(prUrl);
	return { checksPassing: diagnosis.checksPassing, autoMerge: diagnosis.autoMerge };
}

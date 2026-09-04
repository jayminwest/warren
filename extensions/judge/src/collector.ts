/**
 * The collector daemon (plan pl-17ca step 6): poll `GET /runs` for
 * newly-terminal runs, drive one judgment per terminal run, checkpoint
 * the cursor ONLY after the verdict store accepts the result.
 *
 * Delivery guarantee: AT-LEAST-ONCE, the audit-log discipline. A kill
 * between the store accept and the cursor checkpoint replays the run next
 * cycle, and the verdict store's dedupe key
 * `(runId, rubricVersion, judgeModelId)` makes that replay an exact
 * no-op. A crash BEFORE the accept re-judges from scratch — no run is
 * ever skipped.
 *
 * Budget gates (agent-analytics §12.5), checked per run before judging:
 *   - `JUDGE_DAILY_BUDGET_USD` fleet-wide: when the day's ledgered spend
 *     reaches the budget the run is DEFERRED — no marker, no checkpoint,
 *     so it re-enters the candidate set once budget frees (the next UTC
 *     day). The hole stays visible in the cycle stats and the deferral
 *     log line, never as a permanent write-off: a `budget_exceeded`
 *     marker would checkpoint the run closed under this
 *     (rubricVersion, judgeModelId) pair AND occupy the store's dedupe
 *     key, blocking the eventual real verdict (warren-5fcf — a backlog
 *     larger than one day's budget would have been burned unjudged on
 *     day one).
 *   - `JUDGE_MAX_COST_USD` per judgment: passed to the judge loop as its
 *     cost cap, clamped to the remaining daily budget so one judgment
 *     cannot push the fleet past the day gate. A judgment that hits its
 *     cap mid-attempt DOES resolve with a `budget_exceeded` marker — the
 *     attempts were billed, and retrying an over-cap run burns the same
 *     budget again.
 *
 * Sequencing is serial: one judgment at a time, so the daily gate's
 * read-then-judge is race-free and a graceful shutdown has at most one
 * in-flight judgment to finish.
 */

import { listRuns, type WarrenClient } from "./client.ts";
import type { JudgmentCursorStore } from "./cursor-store.ts";
import type { JudgeOutcome } from "./judge-loop.ts";
import { dayKey, type SpendLedger } from "./spend-ledger.ts";
import type { VerdictStore } from "./verdict-store.ts";
import { type RunListRow, isTerminalRunState } from "./warren-wire.ts";

/**
 * The judge seam: resolve one run to a verdict or an unjudged marker.
 * Production wraps `judgeRun` over the pi session factory; tests stub it.
 * `maxCostUsd` is the effective per-judgment cap for THIS judgment
 * (per-judgment cap clamped to the remaining daily budget).
 */
export type JudgeFn = (runId: string, opts: { maxCostUsd: number }) => Promise<JudgeOutcome>;

export interface JudgeCollectorDeps {
	readonly client: WarrenClient;
	readonly verdicts: VerdictStore;
	readonly cursors: JudgmentCursorStore;
	readonly spend: SpendLedger;
	readonly judge: JudgeFn;
	readonly rubricVersion: string;
	readonly judgeModelId: string;
	/** Per-judgment USD cap (JUDGE_MAX_COST_USD). */
	readonly maxCostUsdPerJudgment: number;
	/** Fleet-wide daily USD budget (JUDGE_DAILY_BUDGET_USD). */
	readonly dailyBudgetUsd: number;
	/** Runs fetched per discovery page (server caps at 500). */
	readonly runsPageSize?: number;
	/** Injectable for tests — the daily budget buckets by its UTC day. */
	readonly now?: () => Date;
	/** Per-run failures land here; the cycle continues with the next run. */
	readonly onRunError?: (runId: string, err: unknown) => void;
	/** After every accepted judgment — the operator's visibility feed. */
	readonly onJudgment?: (runId: string, outcome: JudgeOutcome) => void;
	/**
	 * Once per cycle when the fleet gate first trips — loud by design
	 * (§12.5), but once, not once per deferred run (a big backlog would
	 * repeat the line hundreds of times every cycle).
	 */
	/** Once per cycle, when a $0 failure is skipped instead of marked. */
	readonly onZeroCostSkipped?: (runId: string, detail: string) => void;
	readonly onBudgetDeferred?: (runId: string, detail: string) => void;
}

export interface JudgeCycleStats {
	readonly runsDiscovered: number;
	readonly terminalRuns: number;
	readonly judged: number;
	readonly alreadyJudged: number;
	/** Runs deferred (not judged, not marked) because the daily budget is spent. */
	readonly budgetDeferred: number;
	/** Runs skipped (not marked, not checkpointed) because the attempt cost $0. */
	readonly zeroCostSkipped: number;
}

const DEFAULT_RUNS_PAGE_SIZE = 500;

/**
 * Discover every run by paging the full list from offset 0. FRICTION §1:
 * no "changed since" parameter exists, so this is a full re-list every
 * cycle. Re-seeing a row is harmless — the cursor gate and the store's
 * dedupe key both absorb it.
 */
async function discoverRuns(client: WarrenClient, pageSize: number): Promise<RunListRow[]> {
	const runs: RunListRow[] = [];
	let offset = 0;
	while (true) {
		const page = await listRuns(client, { limit: pageSize, offset });
		runs.push(...page.runs);
		if (page.runs.length < pageSize) return runs;
		offset += page.runs.length;
	}
}

/**
 * Judge one terminal run: judge, store, ledger, checkpoint — in that
 * order, and the checkpoint is always last. The fleet budget gate lives
 * in the cycle loop (a gated run is deferred, never resolved); this
 * function only clamps the per-judgment cap to the remaining budget.
 */
async function judgeOneRun(
	runId: string,
	remainingBudgetUsd: number,
	deps: JudgeCollectorDeps,
	now: () => Date,
): Promise<"judged" | "zero_cost_skipped"> {
	const maxCostUsd = Math.min(deps.maxCostUsdPerJudgment, remainingBudgetUsd);
	const outcome = await deps.judge(runId, { maxCostUsd });

	if (outcome.kind !== "verdict" && outcome.stats.costUsd === 0) {
		// SKIP, never mark, and never checkpoint: a marker earns its place
		// because the attempts were billed, and a $0 attempt was not. The
		// cursor is per run, so leaving it alone re-lists this run next
		// cycle instead of losing it behind a marker no model produced.
		return "zero_cost_skipped";
	}

	if (outcome.kind === "verdict") {
		deps.verdicts.recordVerdict(outcome.verdict);
	} else {
		deps.verdicts.recordUnjudged({
			runId,
			rubricVersion: deps.rubricVersion,
			judgeModelId: deps.judgeModelId,
			reason: outcome.reason,
			detail: outcome.detail,
		});
	}
	// Spend is ledgered for every outcome that produced one: an unjudged
	// marker is not a refund, the provider billed the attempts either way.
	deps.spend.record(outcome.stats.costUsd, now());
	// Checkpoint ONLY after the store accepted (audit-log discipline).
	deps.cursors.checkpoint(runId, {
		rubricVersion: deps.rubricVersion,
		judgeModelId: deps.judgeModelId,
		outcome: outcome.kind,
		updatedAt: now().toISOString(),
	});
	deps.onJudgment?.(runId, outcome);
	return "judged";
}

/** One full poll cycle: discover, then judge every newly-terminal run. */
export async function collectOnce(deps: JudgeCollectorDeps): Promise<JudgeCycleStats> {
	const now = deps.now ?? (() => new Date());
	const runs = await discoverRuns(deps.client, deps.runsPageSize ?? DEFAULT_RUNS_PAGE_SIZE);
	// Oldest first: a backlog drains in completion order, and the daily
	// budget lands on the oldest unjudged runs rather than the newest.
	const terminal = runs
		.filter((r) => isTerminalRunState(r.state))
		.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

	let judged = 0;
	let alreadyJudged = 0;
	let budgetDeferred = 0;
	let deferralAnnounced = false;
	let zeroCostSkipped = 0;
	let zeroCostAnnounced = false;
	for (const run of terminal) {
		if (!deps.cursors.needsJudgment(run.id, deps.rubricVersion, deps.judgeModelId)) {
			alreadyJudged += 1;
			continue;
		}
		// Fleet gate: past the daily budget the run is DEFERRED — no
		// marker, no checkpoint — so it re-enters the candidate set once
		// budget frees. Re-read per run: each judgment moves the ledger.
		const today = dayKey(now());
		const spentToday = deps.spend.spendForDay(today);
		const remaining = deps.dailyBudgetUsd - spentToday;
		if (remaining <= 0) {
			budgetDeferred += 1;
			if (!deferralAnnounced) {
				deferralAnnounced = true;
				deps.onBudgetDeferred?.(
					run.id,
					`fleet daily budget $${deps.dailyBudgetUsd.toFixed(4)} exhausted ` +
						`($${spentToday.toFixed(4)} spent on ${today}); deferring until budget frees`,
				);
			}
			continue;
		}
		try {
			const result = await judgeOneRun(run.id, remaining, deps, now);
			if (result === "zero_cost_skipped") {
				zeroCostSkipped += 1;
				if (!zeroCostAnnounced) {
					zeroCostAnnounced = true;
					deps.onZeroCostSkipped?.(
						run.id,
						"judgment failed at $0.0000, not marked; the run stays a candidate",
					);
				}
			} else {
				judged += 1;
			}
		} catch (err) {
			// Per-run isolation: one failing judgment (warren unreachable,
			// wire drift, store error) must not starve the others. The
			// cursor did not advance, so the next cycle retries this run.
			deps.onRunError?.(run.id, err);
		}
	}
	return {
		runsDiscovered: runs.length,
		terminalRuns: terminal.length,
		judged,
		alreadyJudged,
		budgetDeferred,
		zeroCostSkipped,
	};
}

export interface RunJudgeCollectorOptions extends JudgeCollectorDeps {
	readonly pollIntervalMs: number;
	readonly signal?: AbortSignal;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Cycle-level failures (discovery unreachable) land here. */
	readonly onCycleError?: (err: unknown) => void;
	/** After every completed cycle — the health surface's liveness feed. */
	readonly onCycle?: (stats: JudgeCycleStats) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The collector loop: cycle, sleep, repeat until the signal aborts.
 * Graceful shutdown: the loop only observes the abort BETWEEN cycles, and
 * `collectOnce` awaits each judgment to completion, so SIGTERM/SIGINT
 * always lets the in-flight judgment finish and checkpoint before exit.
 */
export async function runJudgeCollector(opts: RunJudgeCollectorOptions): Promise<void> {
	const sleep = opts.sleep ?? defaultSleep;
	while (opts.signal?.aborted !== true) {
		try {
			const stats = await collectOnce(opts);
			opts.onCycle?.(stats);
		} catch (err) {
			opts.onCycleError?.(err);
		}
		await sleep(opts.pollIntervalMs);
	}
}

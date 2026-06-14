/**
 * Mid-run spend-cap enforcement for the event bridge (warren-a63d).
 *
 * The bridge accumulates pi's cumulative `turn_end` cost as events flow
 * through. When that cost crosses the run's resolved cap
 * (`resolveCostCapUsd` over `runs.rendered_agent_json` — the per-trigger
 * override already folded over the per-agent value), `enforceBudgetCap`:
 *
 *   1. persists the observed usage so `runs.cost_usd` reflects the spend
 *      that tripped the cap (the bridge would otherwise only checkpoint
 *      on the terminal envelope, which never arrives once we cancel),
 *   2. emits a `budget.exceeded` system event onto the run's log so the
 *      operator sees WHY the run was cut, and
 *   3. requests a graceful burrow cancel via the injected seam.
 *
 * It returns `true` to signal the caller to break the stream with a
 * `cancelled` terminal outcome; reap finalizes the warren row from there.
 * All steps are best-effort — a persist / event / cancel failure is
 * logged and swallowed so enforcement never throws out of the bridge.
 */

import type { Repos } from "../../db/repos/index.ts";
import { isOverBudget } from "../cost-cap.ts";
import type { RunEventBroker } from "../events.ts";
import type { SessionStatsAccumulator } from "../usage-aggregate.ts";
import { persistInStreamUsage } from "./stats.ts";
import type { BridgeLogger } from "./types.ts";

/** Graceful-cancel seam the bridge plugs with its burrow client. */
export type CancelBurrowRunFn = (reason: string) => Promise<void>;

export interface EnforceBudgetCapInput {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly costCapUsd: number | null;
	/** Pi accumulator (preferred when it has observed real usage). */
	readonly piUsage: SessionStatsAccumulator;
	/** Claude accumulator (fallback when no pi `turn_end` fired). */
	readonly claudeUsage: SessionStatsAccumulator;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly cancelBurrowRun: CancelBurrowRunFn;
	readonly logger?: BridgeLogger;
}

/**
 * Evaluate the run's cumulative cost against its cap. Returns `true` when
 * the cap was exceeded (caller should break with `cancelled`), `false`
 * otherwise. Reads pi cost when observed, else claude cost.
 */
export async function enforceBudgetCap(input: EnforceBudgetCapInput): Promise<boolean> {
	const usePi = input.piUsage.seen;
	const observedCostUsd = usePi ? input.piUsage.costUsd : input.claudeUsage.costUsd;
	if (!isOverBudget(observedCostUsd, input.costCapUsd)) return false;

	const capUsd = input.costCapUsd as number;
	input.logger?.warn?.(
		{ runId: input.runId, burrowRunId: input.burrowRunId, observedCostUsd, capUsd },
		"run exceeded spend cap; cancelling",
	);

	// Persist the spend that tripped the cap so cost_usd isn't left null.
	await persistInStreamUsage({
		usage: usePi ? input.piUsage : input.claudeUsage,
		runtime: usePi ? "pi" : "claude",
		runId: input.runId,
		burrowRunId: input.burrowRunId,
		repos: input.repos,
		...(input.logger !== undefined ? { logger: input.logger } : {}),
	});

	await emitBudgetEvent(input, observedCostUsd, capUsd);

	try {
		await input.cancelBurrowRun(`spend cap exceeded: $${observedCostUsd} > $${capUsd}`);
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"budget-cap burrow cancel failed; reap will finalize from terminal-detect",
		);
	}
	return true;
}

async function emitBudgetEvent(
	input: EnforceBudgetCapInput,
	observedCostUsd: number,
	capUsd: number,
): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			burrowEventSeq: seq,
			ts: new Date().toISOString(),
			kind: "budget.exceeded",
			stream: "system",
			payload: { costUsd: observedCostUsd, capUsd },
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger?.error?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			"failed to emit budget.exceeded event",
		);
	}
}

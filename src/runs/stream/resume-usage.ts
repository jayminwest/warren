/**
 * Resume-safe usage accounting for the event bridge (warren-1247, gh #1306).
 *
 * A reconnecting `bridgeRunStream` call resumes after the persisted cursor
 * and dedups every `seq <= resumeSeq` event, so its fresh accumulators would
 * only see the new stream segment: the spend cap compared segment cost, not
 * run cost, and the terminal write understated `runs.cost_usd`.
 * `seedResumeUsage` folds the run's already-persisted usage envelopes through
 * the same accumulators the bridge uses, so a reconnected run and an
 * uninterrupted run reach the same totals and the same cap decision. Claude's
 * cumulative `result` envelope folds in `assign` mode, so replaying it never
 * doubles.
 */

import type { Repos } from "../../db/repos/index.ts";
import {
	accumulatePiUsage,
	extractClaudeUsage,
	newSessionStatsAccumulator,
	type SessionStatsAccumulator,
	type UsageEventInput,
} from "../usage-aggregate.ts";
import type { BridgeLogger } from "./types.ts";

export interface BridgeUsage {
	readonly piUsage: SessionStatsAccumulator;
	readonly claudeUsage: SessionStatsAccumulator;
}

/**
 * Build the bridge's usage accumulators, seeded from persisted usage rows
 * with `seq <= resumeSeq`. A fresh stream (`resumeSeq === 0`) reads nothing.
 * Best-effort: a read failure logs and returns empty accumulators (the
 * pre-fix behavior), so accounting never blocks streaming.
 */
export async function seedResumeUsage(
	repos: Repos,
	runId: string,
	resumeSeq: number,
	logger: BridgeLogger | undefined,
): Promise<BridgeUsage> {
	const usage: BridgeUsage = {
		piUsage: newSessionStatsAccumulator(),
		claudeUsage: newSessionStatsAccumulator(),
	};
	if (resumeSeq <= 0) return usage;
	try {
		const rows = await repos.events.listUsageEvents([runId]);
		for (const row of rows) {
			if (row.sandboxEventSeq > resumeSeq) continue;
			// Carry `origin` so the provenance gate (warren-6646) refuses the
			// same agent-authored rows the live bridge refused.
			const event: UsageEventInput = {
				kind: row.kind,
				stream: row.stream,
				...(row.origin !== null ? { origin: row.origin } : {}),
				payload: row.payloadJson,
			};
			accumulatePiUsage(usage.piUsage, event);
			extractClaudeUsage(usage.claudeUsage, event);
		}
	} catch (err) {
		logger?.warn?.(
			{ runId, resumeSeq, err: err instanceof Error ? err.message : String(err) },
			"failed to seed resumed usage; spend accounting restarts from this stream segment",
		);
		return {
			piUsage: newSessionStatsAccumulator(),
			claudeUsage: newSessionStatsAccumulator(),
		};
	}
	return usage;
}

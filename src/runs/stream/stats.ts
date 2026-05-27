/**
 * Pi + claude cost-stats persistence (warren-a7dc, warren-17a4,
 * warren-87f9). Two paths into `RunsRepo.attachStats`:
 *
 *   - `persistPiStatsDelta` — out-of-band `PiStatsClient` (baseline +
 *     terminal snapshot, delta persisted). Used when the wire format
 *     doesn't carry usage (declarative stubs, custom dispatchers).
 *   - `persistInStreamUsage` — accumulator already populated from
 *     in-stream `turn_end` / `result` envelopes; persisted verbatim.
 *
 * All persistence is best-effort: attachStats failures are logged and
 * swallowed so a cost-write error never fails the bridge or the run.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { SessionStatsAccumulator } from "../usage-aggregate.ts";
import type { BridgeLogger, PiStatsClient, SessionStats } from "./types.ts";

/**
 * Snapshot pi's get_session_stats RPC, swallowing failures (transport
 * error, channel closed, agent isn't pi). The `phase` tag lands in the
 * log message so operators can tell baseline-failed from terminal-failed.
 */
export async function snapshotStats(
	client: PiStatsClient,
	burrowRunId: string,
	signal: AbortSignal,
	phase: "baseline" | "terminal",
	runId: string,
	logger: BridgeLogger | undefined,
): Promise<SessionStats | null> {
	try {
		return await client.fetch(burrowRunId, signal);
	} catch (err) {
		logger?.warn?.(
			{
				runId,
				burrowRunId,
				phase,
				err: err instanceof Error ? err.message : String(err),
			},
			"pi get_session_stats failed; cost columns will stay null",
		);
		return null;
	}
}

export interface PersistPiStatsInput {
	readonly piStats: PiStatsClient;
	readonly burrowRunId: string;
	readonly runId: string;
	readonly repos: Repos;
	readonly baseline: Promise<SessionStats | null> | undefined;
	readonly signal: AbortSignal;
	readonly logger?: BridgeLogger;
}

/**
 * Compute (terminal − baseline) and persist via `RunsRepo.attachStats`.
 * Resolved pi sessions reuse prior turns via `--continue`/`--session`, so
 * `get_session_stats` always returns the session-cumulative number. The
 * delta is the only safe per-run accounting (plan risk #3). If the
 * baseline was missing (RPC failed at start), the delta defaults to the
 * terminal value verbatim — better to over-attribute than under-report.
 * Terminal failure leaves the row untouched.
 */
export async function persistPiStatsDelta(input: PersistPiStatsInput): Promise<void> {
	const terminal = await snapshotStats(
		input.piStats,
		input.burrowRunId,
		input.signal,
		"terminal",
		input.runId,
		input.logger,
	);
	if (terminal === null) return;
	const baseline = input.baseline !== undefined ? await input.baseline : null;
	const base: SessionStats = baseline ?? {
		costUsd: 0,
		tokensInput: 0,
		tokensOutput: 0,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
	};
	const delta = {
		costUsd: terminal.costUsd - base.costUsd,
		tokensInput: terminal.tokensInput - base.tokensInput,
		tokensOutput: terminal.tokensOutput - base.tokensOutput,
		tokensCacheRead: terminal.tokensCacheRead - base.tokensCacheRead,
		tokensCacheWrite: terminal.tokensCacheWrite - base.tokensCacheWrite,
	};
	try {
		await input.repos.runs.attachStats(input.runId, delta);
		input.logger?.info?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				costUsd: delta.costUsd,
				tokensInput: delta.tokensInput,
				tokensOutput: delta.tokensOutput,
			},
			"persisted pi session-stats delta",
		);
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"attachStats threw; cost columns may be inconsistent",
		);
	}
}

export interface PersistInStreamUsageInput {
	readonly usage: SessionStatsAccumulator;
	readonly runtime: "pi" | "claude";
	readonly runId: string;
	readonly burrowRunId: string;
	readonly repos: Repos;
	readonly logger?: BridgeLogger;
}

/**
 * Persist in-stream-accumulated runtime usage via `RunsRepo.attachStats`.
 * Skips when nothing was observed (non-cost-emitting run) so columns
 * stay null. attachStats throws on storage errors; we log + swallow to
 * match the PiStatsClient path's best-effort posture. The `runtime`
 * tag distinguishes pi (`turn_end` accumulator, warren-17a4) from
 * claude-code (`result` single-shot, warren-87f9) in the log line.
 */
export async function persistInStreamUsage(input: PersistInStreamUsageInput): Promise<void> {
	if (!input.usage.seen) return;
	try {
		await input.repos.runs.attachStats(input.runId, {
			costUsd: input.usage.costUsd,
			tokensInput: input.usage.tokensInput,
			tokensOutput: input.usage.tokensOutput,
			tokensCacheRead: input.usage.tokensCacheRead,
			tokensCacheWrite: input.usage.tokensCacheWrite,
		});
		input.logger?.info?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				runtime: input.runtime,
				costUsd: input.usage.costUsd,
				tokensInput: input.usage.tokensInput,
				tokensOutput: input.usage.tokensOutput,
			},
			"persisted in-stream usage totals",
		);
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				runtime: input.runtime,
				err: err instanceof Error ? err.message : String(err),
			},
			"attachStats threw on in-stream usage; cost columns may stay null",
		);
	}
}

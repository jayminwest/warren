/**
 * Active-stream recovery (warren-041e split). On warren restart, walk
 * the runs table for rows in {queued, running} that already have a
 * `burrow_run_id` and start a bridge for each. Idempotent across
 * restarts: the resume-seq filter inside the bridge means re-subscribing
 * to a run we already have full history for is harmless.
 */

import type { BurrowClientPool } from "../../burrow-client/pool.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import type { BridgeLogger, BridgeRunStreamInput, BridgeRunStreamResult } from "./types.ts";

export interface RecoverActiveRunStreamsInput {
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClientPool: BurrowClientPool;
	readonly logger?: BridgeLogger;
	/** Override the bridge factory (tests). Defaults to `bridgeRunStream`. */
	readonly bridge?: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
}

export interface ActiveBridge {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly abort: AbortController;
	readonly done: Promise<BridgeRunStreamResult>;
}

export interface RecoverActiveRunStreamsResult {
	readonly bridges: readonly ActiveBridge[];
	readonly skipped: readonly {
		runId: string;
		reason: "no_burrow_run_id" | "no_burrow_id";
	}[];
}

/**
 * Walk the runs table for rows in {queued, running} that have a
 * `burrow_run_id` attached and start a bridge for each. Idempotent
 * across restarts; the resume seq filter means re-subscribing to a
 * run we already have full history for is harmless. Returns
 * controllers so the caller can `abort()` on shutdown.
 *
 * Runs in active states without a `burrow_run_id` are skipped — those
 * are partial spawns (a burrow was provisioned but `POST /runs`
 * never landed) which the spawn flow's rollback should already have
 * cancelled. Surfaced in `skipped` so the operator sees them.
 */
export async function recoverActiveRunStreams(
	input: RecoverActiveRunStreamsInput,
): Promise<RecoverActiveRunStreamsResult> {
	const { repos, broker, burrowClientPool, logger } = input;
	const bridge = input.bridge ?? bridgeRunStream;
	const candidates = await repos.runs.listByState(["queued", "running"]);

	const bridges: ActiveBridge[] = [];
	const skipped: { runId: string; reason: "no_burrow_run_id" | "no_burrow_id" }[] = [];

	for (const run of candidates) {
		if (run.burrowRunId === null) {
			skipped.push({ runId: run.id, reason: "no_burrow_run_id" });
			logger?.warn?.(
				{ runId: run.id, state: run.state },
				"skipping recovery: run has no burrow_run_id",
			);
			continue;
		}
		if (run.burrowId === null) {
			// Active row with a burrow_run_id but no burrow_id is malformed
			// (spawn writes burrow_id first). Skip rather than crash; warren
			// doctor surfaces orphaned rows.
			skipped.push({ runId: run.id, reason: "no_burrow_id" });
			logger?.warn?.(
				{ runId: run.id, state: run.state, burrowRunId: run.burrowRunId },
				"skipping recovery: run has burrow_run_id but no burrow_id",
			);
			continue;
		}
		const abort = new AbortController();
		const bridgeInput: BridgeRunStreamInput = {
			runId: run.id,
			burrowRunId: run.burrowRunId,
			burrowId: run.burrowId,
			repos,
			broker,
			burrowClientPool,
			signal: abort.signal,
			...(logger !== undefined ? { logger } : {}),
		};
		const done = bridge(bridgeInput);
		bridges.push({
			runId: run.id,
			burrowRunId: run.burrowRunId,
			abort,
			done,
		});
		logger?.info?.(
			{ runId: run.id, burrowRunId: run.burrowRunId, state: run.state },
			"resumed run stream bridge",
		);
	}

	return { bridges, skipped };
}

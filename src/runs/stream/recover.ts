/**
 * Active-stream recovery (warren-041e split). On warren restart, walk
 * the runs table for rows in {queued, running} that already have a
 * `sandbox_run_id` and start a bridge for each. Idempotent across
 * restarts: the resume-seq filter inside the bridge means re-subscribing
 * to a run we already have full history for is harmless.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import type { BridgeLogger, BridgeRunStreamInput, BridgeRunStreamResult } from "./types.ts";

export interface RecoverActiveRunStreamsInput {
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	/**
	 * The boot-resolved runtime provider (warren-1fce). Each recovered run's
	 * bridge re-attaches through `provider.streamEvents(handle, { sinceSeq })`, so
	 * a restart resumes the stream from the events table's last seq on the active
	 * backend (burrow under `local`, the pod log cursor under `k8s`).
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly logger?: BridgeLogger;
	/** Override the bridge factory (tests). Defaults to `bridgeRunStream`. */
	readonly bridge?: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
}

export interface ActiveBridge {
	readonly runId: string;
	readonly sandboxRunId: string;
	readonly abort: AbortController;
	readonly done: Promise<BridgeRunStreamResult>;
}

export interface RecoverActiveRunStreamsResult {
	readonly bridges: readonly ActiveBridge[];
	readonly skipped: readonly {
		runId: string;
		reason: "no_sandbox_run_id" | "no_sandbox_id";
	}[];
}

/**
 * Walk the runs table for rows in {queued, running} that have a
 * `sandbox_run_id` attached and start a bridge for each. Idempotent
 * across restarts; the resume seq filter means re-subscribing to a
 * run we already have full history for is harmless. Returns
 * controllers so the caller can `abort()` on shutdown.
 *
 * Runs in active states without a `sandbox_run_id` are skipped — those
 * are partial spawns (a burrow was provisioned but `POST /runs`
 * never landed) which the spawn flow's rollback should already have
 * cancelled. Surfaced in `skipped` so the operator sees them.
 */
export async function recoverActiveRunStreams(
	input: RecoverActiveRunStreamsInput,
): Promise<RecoverActiveRunStreamsResult> {
	const { repos, broker, runtimeProvider, logger } = input;
	const bridge = input.bridge ?? bridgeRunStream;
	const candidates = await repos.runs.listByState(["queued", "running"]);

	const bridges: ActiveBridge[] = [];
	const skipped: { runId: string; reason: "no_sandbox_run_id" | "no_sandbox_id" }[] = [];

	for (const run of candidates) {
		if (run.sandboxRunId === null) {
			skipped.push({ runId: run.id, reason: "no_sandbox_run_id" });
			logger?.warn?.(
				{ runId: run.id, state: run.state },
				"skipping recovery: run has no sandbox_run_id",
			);
			continue;
		}
		if (run.sandboxId === null) {
			// Active row with a sandbox_run_id but no sandbox_id is malformed
			// (spawn writes sandbox_id first). Skip rather than crash; warren
			// doctor surfaces orphaned rows.
			skipped.push({ runId: run.id, reason: "no_sandbox_id" });
			logger?.warn?.(
				{ runId: run.id, state: run.state, sandboxRunId: run.sandboxRunId },
				"skipping recovery: run has sandbox_run_id but no sandbox_id",
			);
			continue;
		}
		const abort = new AbortController();
		const bridgeInput: BridgeRunStreamInput = {
			runId: run.id,
			sandboxRunId: run.sandboxRunId,
			sandboxId: run.sandboxId,
			repos,
			broker,
			runtimeProvider,
			signal: abort.signal,
			...(logger !== undefined ? { logger } : {}),
		};
		const done = bridge(bridgeInput);
		bridges.push({
			runId: run.id,
			sandboxRunId: run.sandboxRunId,
			abort,
			done,
		});
		logger?.info?.(
			{ runId: run.id, sandboxRunId: run.sandboxRunId, state: run.state },
			"resumed run stream bridge",
		);
	}

	return { bridges, skipped };
}

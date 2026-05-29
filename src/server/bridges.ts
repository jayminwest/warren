/**
 * Live registry of `bridgeRunStream` controllers.
 *
 * The HTTP server boots, walks the runs table for (queued|running) rows
 * that have a `burrow_run_id`, and attaches a bridge to each — that's
 * the §9 "MAX(events.burrow_event_seq)+1 on warren restart" recovery.
 * Every subsequent `POST /runs` registers a new bridge for the spawned
 * run via `start()`. On shutdown, `stopAll()` aborts everyone in one
 * pass and awaits the drain so the events table stays consistent with
 * the burrow stream cursor.
 *
 * Idempotent against double-start: registering a runId that already has
 * an in-flight bridge is a no-op. That keeps recovery safe to re-run
 * (e.g. supervisor restart that races with a still-being-recorded
 * `POST /runs`).
 *
 * Reconnect on transport errors. `bridgeRunStream` is a single-pass
 * courier — when burrow's stream connection drops mid-run (e.g. the
 * burrow server's 10s `idleTimeout` kills a quiet GET /runs/:id/stream
 * → ECONNRESET in warren, see warren-b8fc + burrow-3d45) it returns
 * `errored: true` and the run keeps emitting events into burrow that
 * warren never sees. The registry wraps the bridge in a backoff loop
 * that re-invokes it until the run reaches a terminal state in warren's
 * DB (the reaper's territory, mx-fadaa2) or the registry is aborted.
 * Each reconnect re-reads `MAX(events.burrow_event_seq)` so the seq
 * dedupe in `bridgeRunStream` keeps the events table consistent.
 *
 * Ghost-run reconciliation (warren-b1a9). When burrow returns 404 for
 * the run's `burrow_run_id` (typically because warren's host machine
 * restarted and burrow lost its in-memory run state), the bridge sets
 * `burrowRunMissing: true` instead of `errored: true`. The registry
 * catches this, stops the reconnect loop, transitions the warren row to
 * `failed` with `failure_reason='burrow_run_lost'`, and emits a
 * `bridge_lost` system event. `bootBridges` also pre-probes each active
 * run via `http.runs.get` and runs the same reconciler before starting
 * a bridge — so a deploy that wipes burrow's in-memory state cleans up
 * ghost rows within one boot tick instead of looping forever on backoff.
 *
 * The registry stays small (one entry per active run); resolved bridges
 * remove themselves automatically so a long-lived server doesn't grow
 * unbounded. Tests inject a stub bridge factory to avoid a real burrow.
 */

import { NotFoundError as BurrowNotFoundError } from "@os-eco/burrow-cli";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PreviewLaunchConfig } from "../preview/launch/index.ts";
import type { PreviewPortAllocator } from "../preview/port-allocator.ts";
import {
	type AutoOpenPrConfig,
	type BridgeLogger,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	bridgeRunStream,
	type ReapRunInput,
	type ReapRunResult,
	type RunEventBroker,
	reapRun,
} from "../runs/index.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { defaultSleep, reconcileLostBurrowRun, runWithReconnect } from "./bridge-reconnect.ts";
import type { BridgeRegistry } from "./types.ts";

interface BridgeEntry {
	readonly burrowRunId: string;
	readonly abort: AbortController;
	readonly done: Promise<BridgeRunStreamResult>;
}

/** Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap. */
export const DEFAULT_RECONNECT_BACKOFF_MS: readonly number[] = [
	1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];

/**
 * warren-6376: number of consecutive errored reconnects before the
 * bridge emits a one-shot `bridge_stalled` system event so the UI can
 * surface an "agent infrastructure unreachable" banner instead of an
 * indefinite spinner. A subsequent reconnect that streams fresh events
 * clears the stall and emits `bridge_recovered`. Exposed via the
 * registry input so tests can lower it.
 */
export const BRIDGE_STALL_THRESHOLD = 3;

export interface CreateBridgeRegistryInput {
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	/**
	 * Multi-worker burrow pool (warren-c0c9 / pl-9ba1 step 5). The registry
	 * threads this into every bridge it starts so `bridgeRunStream` can
	 * resolve the owning worker via `pool.clientFor({burrowId})`. The inline
	 * reap path on `terminalDetected` consumes the same pool.
	 */
	readonly burrowClientPool: BurrowClientPool;
	readonly logger?: BridgeLogger;
	/**
	 * Override the per-run bridge factory (tests). Defaults to the live
	 * `bridgeRunStream` from `../runs/`.
	 */
	readonly bridge?: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
	/**
	 * Override reap (tests). Defaults to the live `reapRun`. Fired when
	 * the bridge returns `terminalDetected` (warren-a69a) so the warren
	 * row finalizes without depending on an external reap scheduler.
	 */
	readonly reap?: (input: ReapRunInput) => Promise<ReapRunResult>;
	/**
	 * Backoff schedule (ms) for reconnecting after `errored: true`. Index
	 * `min(attempt, schedule.length-1)`. Tests pass `[0]` to disable
	 * sleep; production uses `DEFAULT_RECONNECT_BACKOFF_MS`.
	 */
	readonly reconnectBackoffMs?: readonly number[];
	/**
	 * Consecutive errored-reconnect count before the bridge emits a
	 * one-shot `bridge_stalled` event (warren-6376). Defaults to
	 * `BRIDGE_STALL_THRESHOLD`; tests lower it to exercise the path.
	 */
	readonly stallThreshold?: number;
	/** Override the sleep primitive (tests). Default: `setTimeout`-based. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/**
	 * Auto-open-PR config (warren-f6af). Forwarded to reap so the bridge's
	 * inline reap call (terminal-detect path) opens a PR for the agent's
	 * pushed branch. Omit to disable; `bootServer` resolves it from env.
	 */
	readonly autoOpenPr?: AutoOpenPrConfig;
	/**
	 * Per-project warren-config cache (R-19 / warren-f156). When provided
	 * alongside `portAllocator`, the terminal-detect reap loads each run's
	 * `.warren/defaults.json` preview block and forwards it to reap's
	 * `preview_launch` sub-step. Omit to disable preview entirely (e.g.
	 * tests).
	 */
	readonly warrenConfigs?: WarrenConfigCache;
	/**
	 * SQLite-backed port allocator (warren-2277). Same singleton for the
	 * whole warren process; reap's `preview_launch` sub-step calls
	 * `allocator.allocate(runId)` to claim a free port atomically.
	 */
	readonly portAllocator?: PreviewPortAllocator;
	/**
	 * Preview launch host suffix (`WARREN_PREVIEW_HOST`). Drives the
	 * `pr_annotate_preview` URL format; null when the operator hasn't
	 * wired the proxy yet — the launch still runs but no URL is published.
	 */
	readonly previewLaunchConfig?: PreviewLaunchConfig;
}

export function createBridgeRegistry(input: CreateBridgeRegistryInput): BridgeRegistry {
	const live = new Map<string, BridgeEntry>();
	const bridge = input.bridge ?? bridgeRunStream;
	const reap = input.reap ?? reapRun;
	const backoff = input.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
	const stallThreshold = input.stallThreshold ?? BRIDGE_STALL_THRESHOLD;
	const sleep = input.sleep ?? defaultSleep;

	function start(runId: string, burrowRunId: string, burrowId: string): void {
		if (live.has(runId)) return;
		const abort = new AbortController();
		const done = runWithReconnect({
			runId,
			burrowRunId,
			burrowId,
			repos: input.repos,
			broker: input.broker,
			burrowClientPool: input.burrowClientPool,
			signal: abort.signal,
			bridge,
			reap,
			backoff,
			stallThreshold,
			sleep,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
			...(input.autoOpenPr !== undefined ? { autoOpenPr: input.autoOpenPr } : {}),
			...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
			...(input.portAllocator !== undefined ? { portAllocator: input.portAllocator } : {}),
			...(input.previewLaunchConfig !== undefined
				? { previewLaunchConfig: input.previewLaunchConfig }
				: {}),
		});
		const entry: BridgeEntry = { burrowRunId, abort, done };
		live.set(runId, entry);
		// warren-018a: `done` is fire-and-forgotten. Without a `.catch` here,
		// any synchronous-in-bridge throw (placement missing, transient pool
		// error, etc.) rejects an un-awaited promise and Bun terminates the
		// process — which crash-loops the supervisor under docker
		// `restart: unless-stopped`. Catch and surface as a `bridge_fatal`
		// event so the UI shows why the bridge stopped; the run row stays
		// in its current state for the reaper to finalize.
		void done
			.catch(async (err) => {
				const message = err instanceof Error ? err.message : String(err);
				input.logger?.error?.(
					{ runId, burrowRunId, burrowId, err: message },
					"bridge crashed with unhandled error",
				);
				try {
					const seq = ((await input.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
					const row = await input.repos.events.append({
						runId,
						burrowEventSeq: seq,
						ts: new Date().toISOString(),
						kind: "bridge_fatal",
						stream: "system",
						payload: { error: message },
					});
					input.broker.publish(runId, row);
				} catch (eventErr) {
					input.logger?.error?.(
						{
							runId,
							err: eventErr instanceof Error ? eventErr.message : String(eventErr),
						},
						"failed to write bridge_fatal event",
					);
				}
			})
			.finally(() => {
				if (live.get(runId) === entry) live.delete(runId);
			});
	}

	async function stopAll(): Promise<void> {
		const entries = [...live.values()];
		for (const entry of entries) entry.abort.abort();
		await Promise.allSettled(entries.map((e) => e.done));
		live.clear();
	}

	return {
		start,
		stopAll,
		size: () => live.size,
	};
}

export interface BootBridgesResult {
	readonly registry: BridgeRegistry;
	readonly resumed: readonly { runId: string; burrowRunId: string }[];
	/**
	 * Active rows we did NOT attach a bridge to. Reasons:
	 *   - `no_burrow_run_id` / `no_burrow_id` — partial spawn (spawn-rollback territory).
	 *   - `no_placement` — pre-pl-9ba1 orphan: `burrow_id` is set but `burrows` row missing.
	 *   - `burrow_run_lost` (warren-b1a9) — burrow returned 404 for the
	 *     `burrow_run_id`. The reconciler already finalized the warren
	 *     row to `failed`; the bridge isn't started because there's
	 *     nothing to stream.
	 */
	readonly skipped: readonly { runId: string; reason: string }[];
}

/**
 * Build a registry and prime it with bridges for every active run that
 * has a `burrow_run_id`. Active rows missing one are skipped — those
 * are partial spawns the spawn-rollback path should already have
 * cancelled. Surface them in `skipped` so the operator sees the count.
 */
export async function bootBridges(input: CreateBridgeRegistryInput): Promise<BootBridgesResult> {
	const registry = createBridgeRegistry(input);
	const candidates = await input.repos.runs.listByState(["queued", "running"]);
	const resumed: { runId: string; burrowRunId: string }[] = [];
	const skipped: { runId: string; reason: string }[] = [];

	for (const run of candidates) {
		if (run.burrowRunId === null) {
			skipped.push({ runId: run.id, reason: "no_burrow_run_id" });
			input.logger?.warn?.(
				{ runId: run.id, state: run.state },
				"skipping recovery: run has no burrow_run_id",
			);
			continue;
		}
		if (run.burrowId === null) {
			skipped.push({ runId: run.id, reason: "no_burrow_id" });
			input.logger?.warn?.(
				{ runId: run.id, state: run.state, burrowRunId: run.burrowRunId },
				"skipping recovery: run has burrow_run_id but no burrow_id",
			);
			continue;
		}
		// warren-018a: runs predating multi-worker placement (pl-9ba1) carry a
		// burrow_id without a matching `burrows` row. Starting their bridge
		// makes `pool.clientFor({burrowId})` throw NoEligibleWorkerError on
		// the first stream call. Skip with a clean operator signal instead.
		if ((await input.repos.burrows.get(run.burrowId)) === null) {
			skipped.push({ runId: run.id, reason: "no_placement" });
			input.logger?.warn?.(
				{
					runId: run.id,
					state: run.state,
					burrowRunId: run.burrowRunId,
					burrowId: run.burrowId,
				},
				"skipping recovery: burrow_id has no `burrows` row (pre-pl-9ba1 orphan)",
			);
			continue;
		}
		// warren-b1a9: probe burrow for the run BEFORE starting the bridge.
		// On a machine restart burrow may have lost in-flight runs from its
		// in-memory store; without this pre-check the bridge would start,
		// 404 on its first poll, and only then reconcile. The pre-check is
		// cheap (one GET per active run at boot) and gives operators a clean
		// `skipped: 'burrow_run_lost'` signal in the result.
		try {
			const { client } = await input.burrowClientPool.clientFor({ burrowId: run.burrowId });
			await withTransportMapping(client.config, () => client.http.runs.get(run.burrowRunId ?? ""));
		} catch (err) {
			if (err instanceof BurrowNotFoundError) {
				skipped.push({ runId: run.id, reason: "burrow_run_lost" });
				await reconcileLostBurrowRun({
					runId: run.id,
					burrowRunId: run.burrowRunId,
					repos: input.repos,
					broker: input.broker,
					...(input.logger !== undefined ? { logger: input.logger } : {}),
				});
				continue;
			}
			// Transport errors / pool-resolution failures: log and fall through
			// to start the bridge anyway. The bridge's reconnect loop is the
			// correct place to wait for a transiently-unreachable worker; the
			// reconciler is only for the structural "burrow has no record" case.
			input.logger?.warn?.(
				{
					runId: run.id,
					burrowRunId: run.burrowRunId,
					err: err instanceof Error ? err.message : String(err),
				},
				"bootBridges reconcile probe failed (non-404); starting bridge anyway",
			);
		}
		registry.start(run.id, run.burrowRunId, run.burrowId);
		resumed.push({ runId: run.id, burrowRunId: run.burrowRunId });
		input.logger?.info?.(
			{ runId: run.id, burrowRunId: run.burrowRunId, state: run.state },
			"resumed run stream bridge",
		);
	}

	return { registry, resumed, skipped };
}

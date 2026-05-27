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
import type { EventRow, RunState } from "../db/schema.ts";
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
import type { PrTemplateOverrides } from "../runs/pr-template.ts";
import type { ServerPreviewConfig, WarrenConfigCache } from "../warren-config/index.ts";
import type { BridgeRegistry } from "./types.ts";

interface BridgeEntry {
	readonly burrowRunId: string;
	readonly abort: AbortController;
	readonly done: Promise<BridgeRunStreamResult>;
}

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(["succeeded", "failed", "cancelled"]);

/** Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap. */
export const DEFAULT_RECONNECT_BACKOFF_MS: readonly number[] = [
	1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];

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

interface RunWithReconnectInput {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly burrowId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClientPool: BurrowClientPool;
	readonly signal: AbortSignal;
	readonly bridge: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
	readonly reap: (input: ReapRunInput) => Promise<ReapRunResult>;
	readonly backoff: readonly number[];
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly logger?: BridgeLogger;
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly portAllocator?: PreviewPortAllocator;
	readonly previewLaunchConfig?: PreviewLaunchConfig;
}

/**
 * Run `bridgeRunStream` in a loop, reconnecting on `errored: true`
 * with exponential backoff until the run is terminal in warren's DB,
 * the bridge ends naturally (`errored: false` ⇒ burrow closed the
 * stream because the run completed), or the registry aborts.
 */
async function runWithReconnect(input: RunWithReconnectInput): Promise<BridgeRunStreamResult> {
	let totalWritten = 0;
	let totalSkipped = 0;
	let attempt = 0;
	while (true) {
		const bridgeInput: BridgeRunStreamInput = {
			runId: input.runId,
			burrowRunId: input.burrowRunId,
			burrowId: input.burrowId,
			repos: input.repos,
			broker: input.broker,
			burrowClientPool: input.burrowClientPool,
			signal: input.signal,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
		};
		const result = await input.bridge(bridgeInput);
		totalWritten += result.written;
		totalSkipped += result.skipped;

		if (result.burrowRunMissing === true) {
			// warren-b1a9: burrow returned 404 mid-stream. The run is
			// unrecoverable — reconcile the warren row to `failed` so the UI,
			// /readyz, and the next bootBridges pass all stop treating it as
			// live. Don't reconnect; the only thing waiting on the wire is
			// another 404.
			await reconcileLostBurrowRun({
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				repos: input.repos,
				broker: input.broker,
				...(input.logger !== undefined ? { logger: input.logger } : {}),
			});
			return { written: totalWritten, skipped: totalSkipped, errored: false };
		}

		if (result.terminalDetected !== undefined) {
			// warren-a69a: bridge observed a runtime-terminal event. Reap
			// inline so the warren row finalizes without depending on an
			// external scheduler. reap is idempotent + best-effort, so
			// errors land as `reap.completed`/`reap_failed` events on the
			// run rather than escaping back up the registry.
			const previewConfig =
				result.terminalDetected.outcome === "succeeded"
					? await resolveProjectPreviewConfig(input)
					: undefined;
			const prTemplate =
				result.terminalDetected.outcome === "succeeded"
					? await resolveProjectPrTemplate(input)
					: undefined;
			try {
				await input.reap({
					runId: input.runId,
					outcome: result.terminalDetected.outcome,
					repos: input.repos,
					burrowClientPool: input.burrowClientPool,
					broker: input.broker,
					...(input.logger !== undefined ? { logger: input.logger } : {}),
					...(input.autoOpenPr !== undefined ? { autoOpenPr: input.autoOpenPr } : {}),
					...(previewConfig !== undefined ? { previewConfig } : {}),
					...(input.portAllocator !== undefined ? { portAllocator: input.portAllocator } : {}),
					...(input.previewLaunchConfig !== undefined
						? { previewLaunchConfig: input.previewLaunchConfig }
						: {}),
					...(prTemplate !== undefined ? { prTemplate } : {}),
				});
			} catch (err) {
				input.logger?.error?.(
					{
						runId: input.runId,
						burrowRunId: input.burrowRunId,
						err: err instanceof Error ? err.message : String(err),
					},
					"reap threw out of bridge terminal-detect path",
				);
			}
			return { written: totalWritten, skipped: totalSkipped, errored: result.errored };
		}

		if (input.signal.aborted) {
			return { written: totalWritten, skipped: totalSkipped, errored: result.errored };
		}
		if (!result.errored) {
			return { written: totalWritten, skipped: totalSkipped, errored: false };
		}

		// errored=true: the source iterator threw before burrow signalled
		// run-completion. If warren has already finalized the run (reaper
		// won the race), stop — there's nothing left to courier. Else
		// back off and reconnect.
		const row = await input.repos.runs.get(input.runId);
		if (row === null || TERMINAL_RUN_STATES.has(row.state)) {
			input.logger?.info?.(
				{ runId: input.runId, burrowRunId: input.burrowRunId, state: row?.state ?? "unknown" },
				"bridge reconnect stopped: run is terminal",
			);
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}

		const delayMs = input.backoff[Math.min(attempt, input.backoff.length - 1)] ?? 0;
		attempt += 1;
		input.logger?.warn?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				attempt,
				delayMs,
				totalWritten,
				totalSkipped,
			},
			"bridge errored — reconnecting after backoff",
		);
		try {
			await input.sleep(delayMs, input.signal);
		} catch {
			// AbortError — signal fired during sleep. Bail out cleanly.
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}
		if (input.signal.aborted) {
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}
	}
}

/**
 * Resolve the project's `.warren/defaults.json` preview block (R-19) for
 * the run the bridge just observed reach terminal. Returns `undefined`
 * when the project hasn't opted in or when the warren-config seam isn't
 * wired (tests that omit `warrenConfigs`/`portAllocator`). The launcher
 * gate inside reap is what skips the actual preview spawn when this
 * function returns `undefined`.
 *
 * Errors from the per-project loader (`malformed defaults.json`, etc.)
 * surface as a `null` defaults block, so this function returns
 * `undefined` and the preview just skips. Operators see the underlying
 * error via the `/projects/:id/warren-config` route.
 */
async function resolveProjectPreviewConfig(
	input: RunWithReconnectInput,
): Promise<ServerPreviewConfig | undefined> {
	if (input.warrenConfigs === undefined || input.portAllocator === undefined) return undefined;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return undefined;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return undefined;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const preview = config.defaults?.preview;
		if (preview === undefined) return undefined;
		// `type: 'static'` is filed as a follow-up (per SPEC §11.L); reap
		// would reject at launch time anyway. Skip cleanly here so the
		// PR-body placeholder doesn't promise a preview that can't run.
		if (preview.type !== "server") return undefined;
		return preview;
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview config load failed; skipping preview launch",
		);
		return undefined;
	}
}

/**
 * Resolve the project's `.warren/pr-template.md` fragment overrides
 * (warren-bd49) for the run the bridge just observed reach terminal.
 * Returns `undefined` when the project ships no template, when the
 * warren-config seam isn't wired (tests), or when the parsed envelope
 * has no overrides. Errors from the per-project loader surface as
 * a `null` prTemplate in the envelope, so this just falls through to
 * `undefined` and reap uses the built-in defaults. Operators see the
 * underlying error via `/projects/:id/warren-config`.
 */
async function resolveProjectPrTemplate(
	input: RunWithReconnectInput,
): Promise<PrTemplateOverrides | undefined> {
	if (input.warrenConfigs === undefined) return undefined;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return undefined;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return undefined;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const overrides = config.prTemplate;
		if (overrides === null || overrides === undefined) return undefined;
		if (Object.keys(overrides).length === 0) return undefined;
		return overrides;
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"pr-template load failed; falling back to built-in defaults",
		);
		return undefined;
	}
}

interface ReconcileLostBurrowRunInput {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly logger?: BridgeLogger;
	readonly now?: () => Date;
}

/**
 * warren-b1a9: transition a non-terminal warren run to `failed` with
 * `failure_reason='burrow_run_lost'` and emit a `bridge_lost` audit event.
 * Used both by the live-bridge 404 catch and by the boot-time reconciler.
 * Idempotent: a run that's already terminal is left alone (the event is
 * still appended so the UI shows why the bridge stopped).
 *
 * The state machine doesn't allow `queued → failed` directly, so this
 * mirrors reap's `markRunning` shim for queued ghost runs (run never made
 * it to running because the bridge never claimed before burrow lost it).
 */
async function reconcileLostBurrowRun(input: ReconcileLostBurrowRunInput): Promise<void> {
	const now = (input.now ?? (() => new Date()))();
	let finalized = false;
	try {
		const run = await input.repos.runs.get(input.runId);
		if (run === null) {
			return;
		}
		if (TERMINAL_RUN_STATES.has(run.state)) {
			input.logger?.info?.(
				{ runId: input.runId, state: run.state },
				"reconcileLostBurrowRun: run already terminal; skipping finalize",
			);
		} else {
			if (run.state === "queued") {
				await input.repos.runs.markRunning(input.runId, now);
			}
			await input.repos.runs.finalize(input.runId, "failed", now, "burrow_run_lost");
			finalized = true;
		}
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"reconcileLostBurrowRun: failed to finalize run",
		);
	}
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row: EventRow = await input.repos.events.append({
			runId: input.runId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind: "bridge_lost",
			stream: "system",
			payload: {
				burrowRunId: input.burrowRunId,
				reason: "burrow_run_lost",
				finalized,
			},
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"reconcileLostBurrowRun: failed to emit bridge_lost event",
		);
	}
	input.logger?.warn?.(
		{ runId: input.runId, burrowRunId: input.burrowRunId, finalized },
		"reconciled ghost run: burrow no longer knows this burrow_run_id",
	);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
		};
		if (signal.aborted) {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
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

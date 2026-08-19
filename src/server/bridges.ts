/**
 * Live registry of `bridgeRunStream` controllers.
 *
 * The HTTP server boots, walks the runs table for (queued|running) rows
 * that have a `sandbox_run_id`, and attaches a bridge to each — that's
 * the docs/design/runtime-and-supervisor.md "MAX(events.sandbox_event_seq)+1 on warren restart" recovery.
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
 * Each reconnect re-reads `MAX(events.sandbox_event_seq)` so the seq
 * dedupe in `bridgeRunStream` keeps the events table consistent.
 *
 * Ghost-run reconciliation (warren-b1a9). When burrow returns 404 for
 * the run's `sandbox_run_id` (typically because warren's host machine
 * restarted and burrow lost its in-memory run state), the bridge sets
 * `sandboxRunMissing: true` instead of `errored: true`. The registry
 * catches this, stops the reconnect loop, transitions the warren row to
 * `failed` with `failure_reason='sandbox_run_lost'`, and emits a
 * `bridge_lost` system event. `bootBridges` also pre-probes each active
 * run via `http.runs.get` and runs the same reconciler before starting
 * a bridge — so a deploy that wipes burrow's in-memory state cleans up
 * ghost rows within one boot tick instead of looping forever on backoff.
 *
 * The registry stays small (one entry per active run); resolved bridges
 * remove themselves automatically so a long-lived server doesn't grow
 * unbounded. Tests inject a stub bridge factory to avoid a real burrow.
 */

import type { Repos } from "../db/repos/index.ts";
import type { RunMode } from "../db/schema.ts";
import type { PreviewLaunchConfig } from "../preview/launch/index.ts";
import type { PreviewPortAllocator } from "../preview/port-allocator.ts";
import {
	type AutoOpenPrConfig,
	type BridgeLogger,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	bindBridgeLogger,
	bridgeRunStream,
	type RunEventBroker,
	type WatchdogReap,
} from "../runs/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { IssueTracker } from "../tracker/contract.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { defaultSleep, reconcileLostSandboxRun, runWithReconnect } from "./bridge-reconnect.ts";
import type { BridgeRegistry } from "./types.ts";

interface BridgeEntry {
	readonly sandboxRunId: string;
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

/**
 * warren-af76: hard ceiling on consecutive errored reconnects with no
 * forward progress. Past this count, `runWithReconnect` stops looping
 * against an up-but-unresponsive burrow (socket probe times out, so the
 * bridge never sees a clean 404) and finalizes the warren run as `failed`
 * with `failure_reason='sandbox_unreachable'`. Sized so `bridge_stalled`
 * (at `BRIDGE_STALL_THRESHOLD`) fires well before we give up, and so the
 * wall-clock budget under `DEFAULT_RECONNECT_BACKOFF_MS` is roughly four
 * minutes of backoff before finalize. Exposed via the registry input so
 * tests can lower it.
 */
export const BRIDGE_STALL_CEILING = 10;

export interface CreateBridgeRegistryInput {
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	/**
	 * Runtime-provider seam (warren-c531 / warren-5a3f). Threaded into every
	 * bridge the registry starts so `bridgeRunStream`'s event stream + run-state
	 * poller speak the ACTIVE backend (`streamEvents`/`status`); the `bootBridges`
	 * ghost-run pre-probe reconciles via `provider.status()` and lost-run teardown
	 * routes through `provider.terminate()`. Boot resolves it once
	 * (`resolveRuntimeProvider`, honoring `WARREN_RUNTIME`) and hands the same
	 * instance here — the registry never speaks the burrow dialect itself, so under
	 * `WARREN_RUNTIME=k8s` there is no stray `LocalProvider`.
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly logger?: BridgeLogger;
	/**
	 * Override the per-run bridge factory (tests). Defaults to the live
	 * `bridgeRunStream` from `../runs/`.
	 */
	readonly bridge?: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
	/**
	 * The reap seam fired when the bridge returns `terminalDetected` (warren-a69a)
	 * so the warren row finalizes without an external scheduler. Pre-bound by the
	 * boot composition root to `reapRun` with the local burrow client applied
	 * (`WatchdogReap`, warren-5a3f) so the registry never speaks the burrow dialect;
	 * reap keeps its LocalProvider workspace reads until warren-fbbf. Tests inject
	 * their own to capture the call; when omitted (harnesses that never trigger a
	 * terminal detect), the terminal-detect path throws and is caught + logged.
	 */
	readonly reap?: WatchdogReap;
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
	/**
	 * Consecutive errored-reconnect count after which the bridge gives up
	 * and finalizes the run as `failed` / `sandbox_unreachable` (warren-af76)
	 * rather than reconnecting forever against an unresponsive burrow.
	 * Defaults to `BRIDGE_STALL_CEILING`; tests lower it to exercise the
	 * path.
	 */
	readonly stallCeiling?: number;
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
	/**
	 * Seeds-CLI seam (warren-41d5). Threaded into every bridge's inline
	 * reap call so the auto_plan_run sub-step validates a new plan's child
	 * seeds (via `showSeed`) before dispatching a plan-run, mirroring the
	 * manual `POST /plan-runs` handler. Omit to skip validation (tests).
	 */
	readonly seedsCli?: SeedsCliDeps;
	/**
	 * Boot-resolved IssueTracker (warren-5819) — threaded beside `seedsCli`
	 * into the reconnect path's inline reap. Threading seam; the reap port
	 * to the tracker contract lands in warren-47b0.
	 */
	readonly issueTracker?: IssueTracker;
	/**
	 * Infra-lost auto-retry hook (warren-4af7). Threaded into every bridge's
	 * `runWithReconnect` (the mid-stream 404 reconcile) and into the
	 * `bootBridges` ghost-run reconcile, so a run that terminalizes
	 * `failed`/`sandbox_run_lost` earns ONE automatic re-dispatch
	 * (`src/runs/retry/infra-lost-retry.ts`). Omit to disable (tests).
	 */
	readonly onInfraLostRun?: (runId: string) => Promise<void>;
	/**
	 * Called with the freshly-created registry inside `bootBridges`, BEFORE
	 * the ghost-run reconcile loop (warren-4af7). Lets the boot wiring
	 * late-bind the retry hook's bridge facade so a retry dispatched during
	 * the boot reconcile still gets its event stream attached.
	 */
	readonly onRegistryCreated?: (registry: BridgeRegistry) => void;
}

export function createBridgeRegistry(input: CreateBridgeRegistryInput): BridgeRegistry {
	const live = new Map<string, BridgeEntry>();
	const bridge = input.bridge ?? bridgeRunStream;
	// warren-5a3f: the reap seam is boot-supplied (pre-bound with the burrow client).
	// When a harness omits it and a bridge unexpectedly reports `terminalDetected`,
	// this throws — caught + logged by `runWithReconnect`, never crashing the loop.
	const reap: WatchdogReap =
		input.reap ??
		(() => {
			throw new Error("bridge registry: reap seam not configured");
		});
	const backoff = input.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
	const stallThreshold = input.stallThreshold ?? BRIDGE_STALL_THRESHOLD;
	const stallCeiling = input.stallCeiling ?? BRIDGE_STALL_CEILING;
	const sleep = input.sleep ?? defaultSleep;

	function start(runId: string, sandboxRunId: string, sandboxId: string, mode?: RunMode): void {
		if (live.has(runId)) return;
		const abort = new AbortController();
		const done = runWithReconnect({
			runId,
			sandboxRunId,
			sandboxId,
			repos: input.repos,
			broker: input.broker,
			runtimeProvider: input.runtimeProvider,
			signal: abort.signal,
			bridge,
			reap,
			backoff,
			stallThreshold,
			stallCeiling,
			sleep,
			...(mode !== undefined ? { mode } : {}),
			...(input.logger !== undefined ? { logger: input.logger } : {}),
			...(input.autoOpenPr !== undefined ? { autoOpenPr: input.autoOpenPr } : {}),
			...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
			...(input.portAllocator !== undefined ? { portAllocator: input.portAllocator } : {}),
			...(input.previewLaunchConfig !== undefined
				? { previewLaunchConfig: input.previewLaunchConfig }
				: {}),
			...(input.seedsCli !== undefined ? { seedsCli: input.seedsCli } : {}),
			...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
			...(input.onInfraLostRun !== undefined ? { onInfraLostRun: input.onInfraLostRun } : {}),
		});
		const entry: BridgeEntry = { sandboxRunId, abort, done };
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
					{ runId, sandboxRunId, sandboxId, err: message },
					"bridge crashed with unhandled error",
				);
				try {
					const seq = ((await input.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
					const row = await input.repos.events.append({
						runId,
						sandboxEventSeq: seq,
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
	readonly resumed: readonly { runId: string; sandboxRunId: string }[];
	/**
	 * Active rows we did NOT attach a bridge to. Reasons:
	 *   - `no_sandbox_run_id` / `no_sandbox_id` — partial spawn (spawn-rollback territory).
	 *   - `no_placement` — pre-pl-9ba1 orphan: `sandbox_id` is set but `burrows` row missing.
	 *   - `sandbox_run_lost` (warren-b1a9) — burrow returned 404 for the
	 *     `sandbox_run_id`. The reconciler already finalized the warren
	 *     row to `failed`; the bridge isn't started because there's
	 *     nothing to stream.
	 */
	readonly skipped: readonly { runId: string; reason: string }[];
}

/**
 * Build a registry and prime it with bridges for every active run that
 * has a `sandbox_run_id`. Active rows missing one are skipped — those
 * are partial spawns the spawn-rollback path should already have
 * cancelled. Surface them in `skipped` so the operator sees the count.
 */
export async function bootBridges(input: CreateBridgeRegistryInput): Promise<BootBridgesResult> {
	const registry = createBridgeRegistry(input);
	// warren-4af7: expose the registry to the boot wiring before the ghost
	// reconcile below can fire the retry hook, so a boot-time retry's bridge
	// attaches to THIS registry.
	input.onRegistryCreated?.(registry);
	// warren-c531 / warren-5a3f: the ghost-run pre-probe reconciles via
	// `provider.status()` so it is runtime-aware — under `WARREN_RUNTIME=k8s` a GC'd
	// pod surfaces as `exists:false` exactly as burrow's 404 did, with no direct
	// burrow call. The same boot-resolved instance the registry threads into every
	// bridge.
	const provider: RuntimeProvider = input.runtimeProvider;
	const candidates = await input.repos.runs.listByState(["queued", "running"]);
	const resumed: { runId: string; sandboxRunId: string }[] = [];
	const skipped: { runId: string; reason: string }[] = [];

	for (const run of candidates) {
		if (run.sandboxRunId === null) {
			skipped.push({ runId: run.id, reason: "no_sandbox_run_id" });
			input.logger?.warn?.(
				{ runId: run.id, state: run.state },
				"skipping recovery: run has no sandbox_run_id",
			);
			continue;
		}
		if (run.sandboxId === null) {
			skipped.push({ runId: run.id, reason: "no_sandbox_id" });
			input.logger?.warn?.(
				{ runId: run.id, state: run.state, sandboxRunId: run.sandboxRunId },
				"skipping recovery: run has sandbox_run_id but no sandbox_id",
			);
			continue;
		}
		// warren-b1a9 / warren-c531: reconcile ghost runs BEFORE starting the
		// bridge via `provider.status()`. On a machine restart the backend may
		// have lost in-flight runs from its store; without this pre-check the
		// bridge would start, see the run vanish on its first poll, and only then
		// reconcile. Routing through the provider makes it runtime-aware — a
		// burrow 404 and a GC'd pod both surface as `exists:false`, with no
		// direct burrow call under `WARREN_RUNTIME=k8s`. `status()` never throws
		// on a missing run; a real transport failure DOES throw, and we fall
		// through to start the bridge (its reconnect loop is the correct place to
		// wait for a transiently-unreachable backend).
		let lost = false;
		try {
			const status = await provider.status({
				runId: run.id,
				sandboxId: run.sandboxId,
				providerRunId: run.sandboxRunId,
			});
			lost = !status.exists;
		} catch (err) {
			input.logger?.warn?.(
				{
					runId: run.id,
					sandboxRunId: run.sandboxRunId,
					err: err instanceof Error ? err.message : String(err),
				},
				"bootBridges reconcile probe failed (transport); starting bridge anyway",
			);
		}
		if (lost) {
			skipped.push({ runId: run.id, reason: "sandbox_run_lost" });
			await reconcileLostSandboxRun({
				runId: run.id,
				sandboxRunId: run.sandboxRunId,
				repos: input.repos,
				broker: input.broker,
				...(input.onInfraLostRun !== undefined ? { onInfraLostRun: input.onInfraLostRun } : {}),
				// warren-a7cb / warren-5a3f: route lost-run teardown through the active
				// backend so a boot-time reconcile deletes the pod (K8s) / destroys the
				// burrow (local) via `provider.terminate()`.
				runtimeProvider: input.runtimeProvider,
				logger: bindBridgeLogger(input.logger, {
					run_id: run.id,
					sandbox_run_id: run.sandboxRunId,
				}),
			});
			continue;
		}
		registry.start(run.id, run.sandboxRunId, run.sandboxId, run.mode);
		resumed.push({ runId: run.id, sandboxRunId: run.sandboxRunId });
		input.logger?.info?.(
			{ runId: run.id, sandboxRunId: run.sandboxRunId, state: run.state },
			"resumed run stream bridge",
		);
	}

	return { registry, resumed, skipped };
}

/**
 * Reconnect/stall machinery for the stream-bridge registry (`./bridges.ts`).
 * Extracted to keep both files under the file-size ratchet (warren-4553).
 * `runWithReconnect` runs `bridgeRunStream` in a backoff loop, surfaces degraded
 * state via `bridge_stalled` / `bridge_recovered` events (warren-6376), gives up
 * past a hard stall ceiling (warren-af76), reaps inline on terminal-detect, and
 * reconciles ghost runs (warren-b1a9) via `reconcileLostSandboxRun` (also called
 * at boot). Lost-run sandbox teardown lives in `./bridge-reconnect-teardown.ts`.
 */

import type { Repos } from "../db/repos/index.ts";
import type { EventRow, RunFailureReason, RunMode, RunState } from "../db/schema.ts";
import type { PreviewLaunchConfig } from "../preview/launch/index.ts";
import type { PreviewPortAllocator } from "../preview/port-allocator.ts";
import {
	type AutoOpenPrConfig,
	type BoundBridgeLogger,
	type BridgeLogger,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	bindBridgeLogger,
	isInfraLostRunFailure,
	type RunEventBroker,
	type WatchdogReap,
} from "../runs/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { IssueTracker } from "../tracker/contract.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import {
	resolveProjectPreviewConfig,
	resolveProjectPrTemplate,
} from "./bridge-reconnect-config.ts";
import { teardownLostRunWorkspace } from "./bridge-reconnect-teardown.ts";

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

export interface RunWithReconnectInput {
	readonly runId: string;
	readonly sandboxRunId: string;
	readonly sandboxId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	/**
	 * Runtime-provider seam (warren-c531 / warren-5a3f). Forwarded into every
	 * `bridgeRunStream` pass so the event stream + run-state poller speak the ACTIVE
	 * backend (`streamEvents`/`status`), and into `reconcileLostSandboxRun` so lost-run
	 * teardown routes through `provider.terminate()`. The registry threads the
	 * boot-resolved instance; the reconnect loop never speaks the burrow dialect.
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly signal: AbortSignal;
	readonly bridge: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
	readonly reap: WatchdogReap;
	readonly backoff: readonly number[];
	readonly stallThreshold: number;
	/**
	 * warren-af76: hard ceiling on consecutive errored reconnects with no
	 * forward progress. Past it the bridge stops looping against an
	 * unresponsive-but-present burrow and finalizes the run `failed` with
	 * `failure_reason='sandbox_unreachable'`. Must be `>= stallThreshold`.
	 */
	readonly stallCeiling: number;
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Run mode. Threaded into every `bridgeRunStream` pass. */
	readonly mode?: RunMode;
	readonly logger?: BridgeLogger;
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly portAllocator?: PreviewPortAllocator;
	readonly previewLaunchConfig?: PreviewLaunchConfig;
	/**
	 * Optional seeds-CLI seam (warren-41d5). Forwarded to the inline reap
	 * call so the auto_plan_run sub-step validates child seeds first.
	 */
	readonly seedsCli?: SeedsCliDeps;
	/** Boot-resolved IssueTracker (warren-5819) — seam for the inline reap call. */
	readonly issueTracker?: IssueTracker;
	/** Infra-lost auto-retry hook (warren-4af7), forwarded to the 404 reconcile. */
	readonly onInfraLostRun?: (runId: string) => Promise<void>;
}

/**
 * Run `bridgeRunStream` in a loop, reconnecting on `errored: true`
 * with exponential backoff until the run is terminal in warren's DB,
 * the bridge ends naturally (`errored: false` ⇒ burrow closed the
 * stream because the run completed), or the registry aborts.
 */
export async function runWithReconnect(
	input: RunWithReconnectInput,
): Promise<BridgeRunStreamResult> {
	// warren-9f06: bind run_id + sandbox_run_id once; downstream lines add `event`.
	const log = bindBridgeLogger(input.logger, {
		run_id: input.runId,
		sandbox_run_id: input.sandboxRunId,
	});
	let totalWritten = 0;
	let totalSkipped = 0;
	let attempt = 0;
	// warren-6376: track whether we've emitted `bridge.stalled` so the
	// event is one-shot per stall episode and we know to emit a matching
	// `bridge_recovered` once fresh events stream again.
	let stalled = false;
	while (true) {
		const bridgeInput: BridgeRunStreamInput = {
			runId: input.runId,
			sandboxRunId: input.sandboxRunId,
			sandboxId: input.sandboxId,
			repos: input.repos,
			broker: input.broker,
			// warren-1fce / warren-5a3f: bridge requires the provider seam; the registry
			// threads the boot-resolved backend, so pass it straight through.
			runtimeProvider: input.runtimeProvider,
			signal: input.signal,
			...(input.mode !== undefined ? { mode: input.mode } : {}),
			logger: log,
		};
		const result = await input.bridge(bridgeInput);
		totalWritten += result.written;
		totalSkipped += result.skipped;

		// warren-6376: forward progress (fresh events streamed) clears any
		// active stall and resets the consecutive-error counter so backoff
		// starts fresh on the next drop.
		if (result.written > 0) {
			if (stalled) {
				await emitBridgeSystemEvent({
					runId: input.runId,
					repos: input.repos,
					broker: input.broker,
					kind: "bridge_recovered",
					payload: { sandboxRunId: input.sandboxRunId, totalWritten },
					logger: log,
				});
				log.info(
					{ event: "bridge.recovered", totalWritten },
					"bridge recovered: events streaming again after stall",
				);
				stalled = false;
			}
			attempt = 0;
		}

		if (result.sandboxRunMissing === true) {
			// warren-b1a9: burrow returned 404 mid-stream. The run is
			// unrecoverable — reconcile the warren row to `failed` so the UI,
			// /readyz, and the next bootBridges pass all stop treating it as
			// live. Don't reconnect; the only thing waiting on the wire is
			// another 404.
			await reconcileLostSandboxRun({
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				repos: input.repos,
				broker: input.broker,
				// warren-a7cb: route lost-run teardown through the active backend.
				runtimeProvider: input.runtimeProvider,
				logger: log,
				...(input.onInfraLostRun !== undefined ? { onInfraLostRun: input.onInfraLostRun } : {}),
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
					? await resolveProjectPreviewConfig(input, log)
					: undefined;
			const prTemplate =
				result.terminalDetected.outcome === "succeeded"
					? await resolveProjectPrTemplate(input, log)
					: undefined;
			try {
				await input.reap({
					runId: input.runId,
					outcome: result.terminalDetected.outcome,
					repos: input.repos,
					// warren-a7cb / warren-5a3f: forward the active RuntimeProvider so the
					// inline terminal-detect reap routes finalize + terminate through the
					// ACTIVE backend (in-pod under WARREN_RUNTIME=k8s). The `reap` seam is
					// pre-bound with the burrow client the local backend still needs.
					runtimeProvider: input.runtimeProvider,
					broker: input.broker,
					logger: log,
					// warren-9cce: carry the poller's distilled `failure_reason`
					// (`oom_killed`) so reap finalizes with it instead of inferring an
					// anonymous crash. Absent for the in-stream terminal path.
					...(result.terminalDetected.failureReason !== undefined
						? { failureReason: result.terminalDetected.failureReason }
						: {}),
					...(input.autoOpenPr !== undefined ? { autoOpenPr: input.autoOpenPr } : {}),
					...(previewConfig !== undefined ? { previewConfig } : {}),
					...(input.portAllocator !== undefined ? { portAllocator: input.portAllocator } : {}),
					...(input.previewLaunchConfig !== undefined
						? { previewLaunchConfig: input.previewLaunchConfig }
						: {}),
					...(prTemplate !== undefined ? { prTemplate } : {}),
					...(input.seedsCli !== undefined ? { seedsCli: input.seedsCli } : {}),
					...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
				});
			} catch (err) {
				log.error(
					{
						event: "bridge.reap_threw",
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
			log.info(
				{ event: "bridge.reconnect_stopped", state: row?.state ?? "unknown" },
				"bridge reconnect stopped: run is terminal",
			);
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}

		const delayMs = input.backoff[Math.min(attempt, input.backoff.length - 1)] ?? 0;
		attempt += 1;
		log.warn(
			{
				event: "bridge.reconnecting",
				attempt,
				delayMs,
				totalWritten,
				totalSkipped,
			},
			"bridge errored — reconnecting after backoff",
		);
		// warren-6376: after N consecutive errored reconnects with no
		// forward progress, surface a one-shot `bridge_stalled` system
		// event so the UI can show "agent infrastructure unreachable"
		// rather than an indefinite spinner. The reconnect loop keeps
		// running underneath; `bridge_recovered` fires when events flow.
		if (!stalled && attempt >= input.stallThreshold) {
			await emitBridgeSystemEvent({
				runId: input.runId,
				repos: input.repos,
				broker: input.broker,
				kind: "bridge_stalled",
				payload: { sandboxRunId: input.sandboxRunId, attempts: attempt },
				logger: log,
			});
			log.warn(
				{ event: "bridge.stalled", attempts: attempt },
				"bridge stalled: burrow unreachable across consecutive reconnects",
			);
			stalled = true;
		}
		// warren-af76: hard stall ceiling. Without this, an up-but-unresponsive
		// burrow (socket probe times out ⇒ `sandboxRunMissing:false`) reconnects
		// forever and the run wedges in `running`; finalize `sandbox_unreachable`.
		if (attempt >= input.stallCeiling) {
			log.error(
				{ event: "bridge.giving_up", attempts: attempt },
				"bridge giving up: burrow unreachable past stall ceiling; finalizing run as failed",
			);
			await reconcileLostSandboxRun({
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				repos: input.repos,
				broker: input.broker,
				// warren-a7cb: route lost-run teardown through the active backend.
				runtimeProvider: input.runtimeProvider,
				failureReason: "sandbox_unreachable",
				logger: log,
			});
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}
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

interface EmitBridgeSystemEventInput {
	readonly runId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly kind: string;
	readonly payload: Record<string, unknown>;
	readonly logger: BoundBridgeLogger;
}

/**
 * warren-6376: append a synthetic `stream: 'system'` event for the run
 * and publish it to the live broker. Used for the bridge's degraded-state
 * signalling (`bridge_stalled` / `bridge_recovered`). Best-effort: a
 * failure to persist is logged but never escapes the reconnect loop.
 */
async function emitBridgeSystemEvent(input: EmitBridgeSystemEventInput): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: seq,
			ts: new Date().toISOString(),
			kind: input.kind,
			stream: "system",
			payload: input.payload,
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger.error(
			{
				event: "bridge.system_event_failed",
				kind: input.kind,
				err: err instanceof Error ? err.message : String(err),
			},
			"failed to emit bridge system event",
		);
	}
}

interface ReconcileLostSandboxRunInput {
	readonly runId: string;
	readonly sandboxRunId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	/** warren-9f06: bound at the call site; the boot reconciler may omit it. */
	readonly logger?: BoundBridgeLogger;
	readonly now?: () => Date;
	/**
	 * warren-af76: failure reason for `runs.finalize` + `bridge_lost`.
	 * Default `'sandbox_run_lost'`; stall-ceiling caller passes
	 * `'sandbox_unreachable'`.
	 */
	readonly failureReason?: RunFailureReason;
	/**
	 * Infra-lost auto-retry hook (warren-4af7), fired after a successful
	 * infra-lost finalize — see `src/runs/retry/infra-lost-retry.ts`. Fire-and-log.
	 */
	readonly onInfraLostRun?: (runId: string) => Promise<void>;
	/**
	 * warren-a7cb / warren-5a3f: active backend the lost-run teardown routes through
	 * (`provider.terminate` — K8s pod delete / burrow destroy) so a wedged run's
	 * sandbox doesn't leak. The boot-resolved provider is always threaded here; the
	 * reconciler never resolves its own burrow-backed fallback.
	 */
	readonly runtimeProvider: RuntimeProvider;
}

/**
 * warren-b1a9: transition a non-terminal warren run to `failed` with
 * `failure_reason='sandbox_run_lost'` and emit a `bridge_lost` audit event.
 * Used both by the live-bridge 404 catch and by the boot-time reconciler.
 * Idempotent: an already-terminal run is left alone (the event is still
 * appended). The state machine forbids `queued → failed` directly, so this
 * mirrors reap's `markRunning` shim for queued ghost runs.
 */
export async function reconcileLostSandboxRun(input: ReconcileLostSandboxRunInput): Promise<void> {
	const now = (input.now ?? (() => new Date()))();
	const failureReason: RunFailureReason = input.failureReason ?? "sandbox_run_lost";
	const log = bindBridgeLogger(input.logger, {
		run_id: input.runId,
		sandbox_run_id: input.sandboxRunId,
	});
	let finalized = false;
	let sandboxToDestroy: { id: string; mode: RunMode } | null = null;
	try {
		const run = await input.repos.runs.get(input.runId);
		if (run === null) {
			return;
		}
		if (run.sandboxId !== null) {
			sandboxToDestroy = { id: run.sandboxId, mode: run.mode };
		}
		if (TERMINAL_RUN_STATES.has(run.state)) {
			log.info(
				{ event: "bridge.reconcile_skipped", state: run.state },
				"reconcileLostSandboxRun: run already terminal; skipping finalize",
			);
		} else {
			if (run.state === "queued") {
				await input.repos.runs.markRunning(input.runId, now);
			}
			await input.repos.runs.finalize(input.runId, "failed", now, failureReason);
			finalized = true;
		}
	} catch (err) {
		log.error(
			{
				event: "bridge.reconcile_finalize_failed",
				err: err instanceof Error ? err.message : String(err),
			},
			"reconcileLostSandboxRun: failed to finalize run",
		);
	}
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row: EventRow = await input.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: seq,
			ts: now.toISOString(),
			kind: "bridge_lost",
			stream: "system",
			payload: {
				sandboxRunId: input.sandboxRunId,
				reason: failureReason,
				finalized,
			},
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		log.error(
			{
				event: "bridge.lost_event_failed",
				err: err instanceof Error ? err.message : String(err),
			},
			"reconcileLostSandboxRun: failed to emit bridge_lost event",
		);
	}
	// warren-4f01 / warren-a7cb / warren-5a3f: tear down the sandbox (the terminal
	// run's later `reapRun` short-circuits without doing it) via the provider seam
	// — see `./bridge-reconnect-teardown.ts`, which calls `provider.terminate()` on
	// the boot-resolved backend so nothing here speaks burrow.
	if (sandboxToDestroy !== null) {
		await teardownLostRunWorkspace({
			runId: input.runId,
			sandboxRunId: input.sandboxRunId,
			sandbox: sandboxToDestroy,
			runtimeProvider: input.runtimeProvider,
			emit: (kind, payload) =>
				emitBridgeSystemEvent({
					runId: input.runId,
					repos: input.repos,
					broker: input.broker,
					kind,
					payload,
					logger: log,
				}),
			log,
		});
	}
	log.warn(
		{ event: "bridge.reconciled", finalized },
		"reconciled ghost run: burrow no longer knows this sandbox_run_id",
	);
	// warren-4af7: a freshly-finalized infra-lost run earns ONE automatic retry
	// (src/runs/retry/infra-lost-retry.ts); a stall-ceiling `sandbox_unreachable` does not qualify.
	if (finalized && isInfraLostRunFailure(failureReason) && input.onInfraLostRun !== undefined) {
		try {
			await input.onInfraLostRun(input.runId);
		} catch (err) {
			log.error(
				{ event: "run.retry_failed", err: err instanceof Error ? err.message : String(err) },
				"infra-lost run retry failed",
			);
		}
	}
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
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

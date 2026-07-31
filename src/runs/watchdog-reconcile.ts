/**
 * Terminal-reconcile safety net for the run watchdog (warren-c433).
 *
 * The heartbeat watchdog (`./watchdog.ts`) force-fails runs that go
 * silent-but-busy. This module covers the OTHER failure shape: a run whose
 * provider/pod is already TERMINAL-or-gone but whose warren row is still
 * `running` because the normal terminal-detect → reap path wedged. The canonical
 * case is the K8s pod-exit reap hang — the run-state poller observed the pod
 * complete but the post-terminal stream drain hung, so reap never fired and the
 * row stranded `running` for ~40 min (the warren-c433 incident, run_nejha296p9es).
 *
 * Each tick, for a run idle past the reconcile grace (but under the heartbeat
 * budget), the watchdog probes `provider.status()`. If the pod is terminal-or-gone
 * it force-finalizes the row through reap with the pod's ACTUAL outcome — a
 * `succeeded` pod finalizes succeeded (and its reap re-drives the in-pod finalize:
 * a still-polling pod parks/picks up the intent, an already-lapsed one degrades to
 * the documented finalize-timeout FinalizeResult), a `failed`/gone pod carries its
 * coarse `terminalReason` through to a domain `failure_reason`. Routing through
 * reap (not a bare finalize) also destroys the sandbox — same reclaim philosophy
 * as the heartbeat `forceFail`.
 */

import type { Repos } from "../db/repos/index.ts";
import type { RunFailureReason, RunRow, RunTerminalState } from "../db/schema.ts";
import type { RunHandle, RunStatus, RuntimeProvider, TerminalReason } from "../runtime/contract.ts";
import type { RunEventBroker } from "./events.ts";
import type { AutoOpenPrConfig } from "./pr.ts";
import { type BridgeLogger, bindBridgeLogger } from "./stream/index.ts";
import type { WatchdogReap } from "./watchdog.ts";

/**
 * Event kind emitted when the watchdog reconciles a run whose provider/pod is
 * terminal-or-gone but whose row stayed non-terminal past the grace period
 * (warren-c433). Distinct from `watchdog.timed_out`: the run is not being killed
 * for going silent-but-busy — it already ENDED at the backend and the normal
 * terminal-detect → reap path failed to finalize it (the K8s pod-exit reap hang),
 * so this is a lifecycle-reclaim of an already-dead run.
 */
export const WATCHDOG_TERMINAL_RECONCILED_KIND = "watchdog.terminal_reconciled";

/**
 * Default grace before the terminal-reconcile net force-finalizes a run whose pod
 * is terminal-or-gone but whose row is still non-terminal (warren-c433): 2 minutes.
 * Comfortably longer than a healthy inline terminal-detect → reap (seconds), so the
 * net only fires when that path is genuinely wedged, yet far shorter than the 45-min
 * heartbeat budget so a pod-exit reap hang no longer strands a run for the better
 * part of an hour. Override with `WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS`; pin to 0
 * to disable the net.
 */
export const DEFAULT_WATCHDOG_TERMINAL_RECONCILE_GRACE_MS = 120_000;

/** The subset of the watchdog tick deps the reconcile net drives reap through. */
export interface ReconcileDeps {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly reap: WatchdogReap;
	readonly broker?: RunEventBroker;
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly now?: () => Date;
	readonly logger?: BridgeLogger;
}

/**
 * The terminal state (+ failure reason) to reconcile a stuck `running` run into,
 * projected from the provider's `status()` snapshot — or `null` when the pod is
 * still live (`queued`/`running`), in which case the net leaves the run for a
 * later tick (warren-c433). A vanished pod (`exists:false`) is a lost run; a
 * `failed` pod carries its coarse `terminalReason` through to a domain
 * `failure_reason`; `succeeded`/`cancelled` reconcile to that terminal state so a
 * cleanly-completed pod still finalizes (and its reap re-drives finalize).
 */
export function reconcileTargetFromStatus(
	status: RunStatus,
): { outcome: RunTerminalState; failureReason?: RunFailureReason } | null {
	if (!status.exists) return { outcome: "failed", failureReason: "burrow_run_lost" };
	switch (status.phase) {
		case "succeeded":
			return { outcome: "succeeded" };
		case "cancelled":
			return { outcome: "cancelled" };
		case "failed":
			return { outcome: "failed", failureReason: failureReasonFromTerminal(status.terminalReason) };
		default:
			// queued / running — the pod has not terminated; keep waiting.
			return null;
	}
}

/** Map the provider's coarse `terminalReason` onto a domain `failure_reason`. */
function failureReasonFromTerminal(reason: TerminalReason | undefined): RunFailureReason {
	switch (reason) {
		case "oom_killed":
			return "oom_killed";
		case "evicted":
			return "evicted";
		case "lost":
			return "burrow_run_lost";
		default:
			return "crashed";
	}
}

/**
 * Probe the backend for a run idle past the reconcile grace; if the pod is
 * terminal-or-gone, force-finalize the row through reap and return the reconciled
 * outcome. Returns `null` when the pod is still live, the run has no sandbox
 * handle, or the probe errored transiently (retried next tick) — a transient
 * `status()` failure must never wedge the tick (warren-c433).
 */
export async function maybeReconcileTerminal(
	deps: ReconcileDeps,
	run: RunRow,
	idleMs: number,
	now: Date,
): Promise<RunTerminalState | null> {
	if (run.burrowId === null || run.burrowRunId === null) return null;
	const handle: RunHandle = {
		runId: run.id,
		sandboxId: run.burrowId,
		providerRunId: run.burrowRunId,
	};
	let status: RunStatus;
	try {
		status = await deps.runtimeProvider.status(handle);
	} catch {
		// Transient status error — the net retries on the next tick, never
		// force-finalizing a run it couldn't observe as terminal.
		return null;
	}
	const target = reconcileTargetFromStatus(status);
	if (target === null) return null;
	await forceReconcile(deps, run, status, target, idleMs, now);
	return target.outcome;
}

async function forceReconcile(
	deps: ReconcileDeps,
	run: RunRow,
	status: RunStatus,
	target: { outcome: RunTerminalState; failureReason?: RunFailureReason },
	idleMs: number,
	now: Date,
): Promise<void> {
	const log = bindBridgeLogger(deps.logger, {
		run_id: run.id,
		...(run.burrowRunId !== null ? { burrow_run_id: run.burrowRunId } : {}),
	});
	await emitReconciledEvent(deps, run, status, target.outcome, idleMs, now);
	await deps.reap({
		runId: run.id,
		outcome: target.outcome,
		repos: deps.repos,
		runtimeProvider: deps.runtimeProvider,
		...(target.failureReason !== undefined ? { failureReason: target.failureReason } : {}),
		...(deps.broker !== undefined ? { broker: deps.broker } : {}),
		...(deps.now !== undefined ? { now: deps.now } : {}),
		...(deps.logger !== undefined ? { logger: deps.logger } : {}),
		...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
	});
	log.info(
		{
			event: WATCHDOG_TERMINAL_RECONCILED_KIND,
			idleMs,
			outcome: target.outcome,
			phase: status.phase,
			exists: status.exists,
			...(target.failureReason !== undefined ? { failureReason: target.failureReason } : {}),
			...(status.terminalDetail != null ? { terminalDetail: status.terminalDetail } : {}),
		},
		"watchdog reconciled terminal-but-stuck run",
	);
}

async function emitReconciledEvent(
	deps: ReconcileDeps,
	run: RunRow,
	status: RunStatus,
	outcome: RunTerminalState,
	idleMs: number,
	now: Date,
): Promise<void> {
	const seq = ((await deps.repos.events.maxSeqForRun(run.id)) ?? 0) + 1;
	const row = await deps.repos.events.append({
		runId: run.id,
		burrowEventSeq: seq,
		ts: now.toISOString(),
		kind: WATCHDOG_TERMINAL_RECONCILED_KIND,
		stream: "system",
		payload: {
			idleMs,
			outcome,
			providerPhase: status.phase,
			providerExists: status.exists,
			burrowRunId: run.burrowRunId,
			// The provider's free-text terminal detail (warren-4a95) — e.g. the
			// kubelet's eviction message (`Pod ephemeral local storage usage
			// exceeds the total limit of containers …`). Persisted onto the run's
			// event stream so the cause survives the pod's (and its kubectl
			// events') GC.
			...(status.terminalDetail != null ? { providerDetail: status.terminalDetail } : {}),
		},
	});
	deps.broker?.publish(run.id, row);
}

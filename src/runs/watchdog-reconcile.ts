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
 *
 * ## Cancel intent wins over the lost mapping (warren-fe9b / warren-d15c)
 * A vanished pod (`exists:false`) normally reads as a LOST run — but not when
 * warren itself deleted the pod: `cancelRun` records a `cancel.requested` event
 * on the run's log when it forwards the pod delete, and that intent flips the
 * reconcile target from `failed/sandbox_run_lost` to `cancelled`. Without it,
 * an operator-requested cancel on K8s surfaced as a failure ~25 min later (the
 * pod-watcher's NotFound → lost reconciliation overriding the cancel intent).
 */

import type { Repos } from "../db/repos/index.ts";
import type { RunFailureReason, RunRow, RunTerminalState } from "../db/schema.ts";
import type { RunHandle, RunStatus, RuntimeProvider, TerminalReason } from "../runtime/contract.ts";
import type { RunEventBroker } from "./events.ts";
import type { AutoOpenPrConfig } from "./pr.ts";
import { hasStdinHoldTimeoutWitness } from "./reap/state.ts";
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
 * later tick (warren-c433). A vanished pod (`exists:false`) is a lost run —
 * UNLESS `cancelRequested` records that warren deleted the pod itself, in which
 * case the cancel intent wins and the run reconciles to `cancelled`
 * (warren-fe9b / warren-d15c); a
 * `failed` pod carries its coarse `terminalReason` through to a domain
 * `failure_reason`; `succeeded`/`cancelled` reconcile to that terminal state so a
 * cleanly-completed pod still finalizes (and its reap re-drives finalize).
 *
 * warren-7f0b: a still-LIVE pod is no longer an automatic pass. When the run's
 * event log carries the entrypoint's `stdin_hold_timeout` kill witness, the
 * harness is dead but the pod (entrypoint finalize poller) stays Running — the
 * zombie shape where nothing terminalizes the row and the finalize intent is
 * never parked. `maybeReconcileTerminal` reaps that run as
 * `failed(agent_died)` so the in-pod finalize loop picks up the intent and
 * salvages the workspace before the pod (and its emptyDir) goes away.
 */
export function reconcileTargetFromStatus(
	status: RunStatus,
	cancelRequested = false,
): { outcome: RunTerminalState; failureReason?: RunFailureReason } | null {
	if (!status.exists) {
		if (cancelRequested) return { outcome: "cancelled" };
		return { outcome: "failed", failureReason: "sandbox_run_lost" };
	}
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
		case "preempted":
			return "preempted";
		case "lost":
			return "sandbox_run_lost";
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
	if (run.sandboxId === null || run.sandboxRunId === null) return null;
	const handle: RunHandle = {
		runId: run.id,
		sandboxId: run.sandboxId,
		providerRunId: run.sandboxRunId,
	};
	let status: RunStatus;
	try {
		status = await deps.runtimeProvider.status(handle);
	} catch {
		// Transient status error — the net retries on the next tick, never
		// force-finalizing a run it couldn't observe as terminal.
		return null;
	}
	// warren-fe9b / warren-d15c: the lost mapping only applies when the pod
	// vanished on its own. When warren itself deleted it (a `cancel.requested`
	// event is on the run's log), the cancel intent wins — probed cheaply and
	// only on the exists:false branch so a live pod never pays for the query.
	const cancelRequested = !status.exists && (await hasCancelIntent(deps.repos, run.id));
	const target = reconcileTargetFromStatus(status, cancelRequested);
	if (target === null) {
		// warren-7f0b: the zombie-watchdog shape — the pod still reads Running
		// (the entrypoint lives on, polling finalize-intent for up to its 40-min
		// ceiling) but the event log already carries the entrypoint's
		// `stdin_hold_timeout` kill witness: the harness is dead, the run's
		// liveness is false, and nothing else will reap it. Reap now so the
		// finalize intent parks while the pod (and its emptyDir) is still alive —
		// the in-pod finalize step then collects + salvages the workspace before
		// the pod terminates. Scope: only the watchdog-kill shape; the general
		// infra-death salvage case stays warren-6c94.
		if (await hasStdinHoldTimeoutWitness(deps.repos, run.id)) {
			const died = { outcome: "failed" as const, failureReason: "agent_died" as const };
			await forceReconcile(deps, run, status, died, idleMs, now);
			return died.outcome;
		}
		return null;
	}
	await forceReconcile(deps, run, status, target, idleMs, now, cancelRequested);
	return target.outcome;
}

/**
 * The cancel-intent probe (warren-fe9b): has the operator asked warren to stop
 * this run? `cancelRun` appends a `cancel.requested` event when it forwards the
 * pod delete to the provider, so its presence on the run's log is the durable
 * record that warren itself deleted the pod. Exported for the watchdog tick's
 * fast-path grace, which probes status() sooner for cancel-intent runs.
 */
export async function hasCancelIntent(repos: Repos, runId: string): Promise<boolean> {
	return repos.events.hasKind(runId, "cancel.requested");
}

async function forceReconcile(
	deps: ReconcileDeps,
	run: RunRow,
	status: RunStatus,
	target: { outcome: RunTerminalState; failureReason?: RunFailureReason },
	idleMs: number,
	now: Date,
	cancelRequested = false,
): Promise<void> {
	const log = bindBridgeLogger(deps.logger, {
		run_id: run.id,
		...(run.sandboxRunId !== null ? { sandbox_run_id: run.sandboxRunId } : {}),
	});
	await emitReconciledEvent(deps, run, status, target.outcome, idleMs, now, cancelRequested);
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
			...(cancelRequested ? { cancelRequested: true } : {}),
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
	cancelRequested = false,
): Promise<void> {
	const seq = ((await deps.repos.events.maxSeqForRun(run.id)) ?? 0) + 1;
	const row = await deps.repos.events.append({
		runId: run.id,
		sandboxEventSeq: seq,
		ts: now.toISOString(),
		kind: WATCHDOG_TERMINAL_RECONCILED_KIND,
		stream: "system",
		payload: {
			idleMs,
			outcome,
			providerPhase: status.phase,
			providerExists: status.exists,
			sandboxRunId: run.sandboxRunId,
			// The provider's free-text terminal detail (warren-4a95) — e.g. the
			// kubelet's eviction message (`Pod ephemeral local storage usage
			// exceeds the total limit of containers …`). Persisted onto the run's
			// event stream so the cause survives the pod's (and its kubectl
			// events') GC.
			...(status.terminalDetail != null ? { providerDetail: status.terminalDetail } : {}),
			// warren-fe9b: the cancel intent that flipped a vanished pod from
			// failed/sandbox_run_lost to cancelled — recorded so the reconcile is
			// auditable as an operator stop, not a mysterious loss.
			...(cancelRequested ? { cancelRequested: true } : {}),
		},
	});
	deps.broker?.publish(run.id, row);
}

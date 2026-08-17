/**
 * K8s finalize-intent recovery driver (warren-5202).
 *
 * ## The deadlock this closes
 *
 * Under `WARREN_RUNTIME=k8s` the in-pod harness polls
 * `GET /runs/:id/finalize-intent` after the agent exits, waiting for reap to
 * park a finalize intent with the `FinalizeCoordinator`. The coordinator is
 * IN-MEMORY: a control-plane pod replacement mid-run kills the parked promise
 * with the process. On recovery the resumed bridge can only re-detect the
 * terminal from the pod's log stream — when that window has rotated past the
 * terminal envelope (`stream_gap` / `cursor_predates_retained_logs`), nothing
 * ever reaps the run, no intent is ever parked, and the pod polls forever
 * (observed live on run_j4e5n48y6v9s: 30+ minutes of `finalize-intent 200`
 * at 2s intervals, run row stuck `running`).
 *
 * The pod's own poll is the one signal that survives every restart shape — the
 * pod boundary protects it from the control-plane outage by design. So this
 * module inverts the recovery: the `finalize-intent` handler reports every
 * intent MISS here, and a miss that persists past a grace period (the normal
 * terminal-detect → reap path parks an intent within seconds) drives a
 * recovery reap, which re-parks the intent via `finalizeK8sRun` and lets the
 * ordinary finalize handshake complete.
 *
 * ## Invariants (each pinned by a test)
 *
 *   1. NEVER fires while an intent is parked — the normal path wins; recovery
 *      only covers the path that is already lost.
 *   2. NEVER fires inside the grace window after the first miss — a healthy
 *      bridge-driven reap races the pod's first polls and must not be
 *      double-driven.
 *   3. Single-flight per run — a reap in flight is never stacked by the pod's
 *      2s poll cadence; a thrown reap re-arms the trigger so a transient
 *      failure retries instead of wedging.
 *   4. Only `running` rows with a LIVE pod are recovered. A terminal/gone pod
 *      belongs to the watchdog's terminal-reconcile net (warren-c433); a
 *      terminal row is already converged.
 *   5. Outcome provenance is explicit: the pod-reported agent exit code
 *      (`?agent_exit=`, authoritative — the pod watched the process die), then
 *      the persisted event log's terminal envelope (covers pre-rollout pods
 *      without the hint), then a `succeeded` default whose misclassification
 *      risk is bounded by reap's provider-error (warren-edc3), dropped-commit
 *      (warren-72b9), and finalize-failed (warren-495d) safety nets.
 *   6. LocalProvider is untouched: the hook is only wired under
 *      `WARREN_RUNTIME=k8s`, and no local run ever polls `finalize-intent`.
 *
 * ## Timing
 *
 * The pod gives up at `WARREN_FINALIZE_MAX_WAIT_MS` (default 40 min) and the
 * heartbeat watchdog force-fails at 45 min. Recovery fires ~grace (30s) after
 * the recovered control plane's first served poll, so it lands long before
 * either budget matters — but nothing here depends on that ordering: a pod
 * that already gave up is terminal and belongs to the reconcile net, and a
 * recovery reap that loses its pod mid-finalize degrades to the documented
 * finalize-timeout path and still terminalizes. Intent-miss GETs append no
 * run events, so they never reset the heartbeat anchor — only an actual
 * recovery drive emits (`reap.finalize_recovery`).
 */

import type { Repos } from "../db/repos/index.ts";
import type { RunRow, RunTerminalState } from "../db/schema.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";
import {
	type FinalizeCoordinator,
	sharedFinalizeCoordinator,
} from "../runtime/k8s/finalize-coordinator.ts";
import type { RunEventBroker } from "./events.ts";
import type { AutoOpenPrConfig } from "./pr.ts";
import { type BridgeLogger, bindBridgeLogger } from "./stream/index.ts";
import { detectRuntimeTerminal } from "./stream/terminal-detect.ts";
import type { WatchdogReap } from "./watchdog.ts";

/** Event kind emitted on the run row when a recovery reap is driven. */
export const FINALIZE_RECOVERY_KIND = "reap.finalize_recovery";

/**
 * Grace between a run's FIRST intent miss and the recovery drive (warren-5202):
 * 30s. The healthy terminal-detect → reap path parks an intent within seconds
 * of the pod's first poll, so a miss this old means that path is lost (the
 * restart/log-rotation deadlock). Far below the pod's 40-min give-up and the
 * 45-min heartbeat watchdog, so recovery always lands first; injectable so
 * tests run without real delays.
 */
export const DEFAULT_FINALIZE_RECOVERY_GRACE_MS = 30_000;

/** How far back the event-log outcome scan reads when no exit-code hint rides the poll. */
const TERMINAL_SCAN_TAIL = 50;

/** What the polling pod reported about itself on the intent-miss GET. */
export interface FinalizeIntentMissHint {
	/**
	 * The agent process's exit code, reported by the pod via the
	 * `?agent_exit=` query param (warren-5202). Authoritative when present —
	 * the pod watched the agent exit. Absent on pods built before the hint
	 * shipped; those fall back to the event-log scan.
	 */
	readonly agentExitCode?: number;
}

/** Where the recovery drive read the outcome from (surfaced on the event). */
export type FinalizeRecoveryOutcomeSource = "agent_exit_hint" | "event_log" | "default";

/**
 * The seam the `GET /runs/:id/finalize-intent` handler calls on an intent
 * MISS. Fire-and-forget by contract — the handler never awaits it, so the
 * pod's poll cadence is never coupled to a reap's duration.
 */
export interface FinalizeRecoveryHook {
	onIntentMiss(runId: string, hint?: FinalizeIntentMissHint): void;
	/** Count of recovery reaps driven — test/observability helper. */
	drivenCount(): number;
}

export interface FinalizeRecoveryDeps {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	/** The boot-bound reap seam (same `WatchdogReap` the watchdog drives). */
	readonly reap: WatchdogReap;
	readonly broker?: RunEventBroker;
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly now?: () => Date;
	readonly logger?: BridgeLogger;
	/** Miss-age threshold before recovery fires. Default `DEFAULT_FINALIZE_RECOVERY_GRACE_MS`. */
	readonly graceMs?: number;
	/**
	 * The intent registry the reap path parks into — consulted so recovery
	 * NEVER fires while an intent is live (invariant 1). Defaults to the
	 * process-wide singleton the provider + handler share; tests inject a
	 * private instance.
	 */
	readonly coordinator?: FinalizeCoordinator;
}

export function createFinalizeRecovery(deps: FinalizeRecoveryDeps): FinalizeRecoveryHook {
	const graceMs = deps.graceMs ?? DEFAULT_FINALIZE_RECOVERY_GRACE_MS;
	const coordinator = deps.coordinator ?? sharedFinalizeCoordinator;
	const now = deps.now ?? (() => new Date());
	// First-miss clock per run. Cleared on a parked intent, on a non-running
	// row, and after every drive — a still-stuck run re-arms from scratch so a
	// failed recovery reap is retried, not wedged (invariant 3).
	const firstMissAt = new Map<string, number>();
	const inFlight = new Set<string>();
	let driven = 0;

	/**
	 * The run row worth recovering, or `null` when any guard stands down:
	 * unknown/terminal/non-`running` row, missing sandbox handle, a
	 * terminal-or-gone pod (the watchdog's reconcile net, warren-c433, owns
	 * those; a transient probe error retries on the next poll), or an intent
	 * parked while we probed (invariant 1, re-checked inside the async drive).
	 */
	async function recoverableRun(runId: string): Promise<RunRow | null> {
		const run = await deps.repos.runs.get(runId);
		if (run === null || run.state !== "running") return null;
		if (run.sandboxId === null || run.sandboxRunId === null) return null;
		if (!(await podIsLive(deps.runtimeProvider, run))) return null;
		if (coordinator.peekIntent(runId) !== undefined) return null;
		return run;
	}

	async function recover(runId: string, hint: FinalizeIntentMissHint | undefined): Promise<void> {
		const log = bindBridgeLogger(deps.logger, { run_id: runId });
		try {
			const run = await recoverableRun(runId);
			if (run === null) return;
			const classified = await classifyOutcome(deps.repos, runId, hint);
			await emitRecoveryEvent(deps, run, classified, now());
			driven += 1;
			log.warn(
				{
					event: FINALIZE_RECOVERY_KIND,
					outcome: classified.outcome,
					source: classified.source,
				},
				"pod awaiting a finalize intent no reap will park; driving recovery reap",
			);
			await deps.reap({
				runId: run.id,
				outcome: classified.outcome,
				repos: deps.repos,
				runtimeProvider: deps.runtimeProvider,
				...(deps.broker !== undefined ? { broker: deps.broker } : {}),
				...(deps.now !== undefined ? { now: deps.now } : {}),
				...(deps.logger !== undefined ? { logger: deps.logger } : {}),
				...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
			});
		} finally {
			inFlight.delete(runId);
			firstMissAt.delete(runId);
		}
	}

	return {
		onIntentMiss(runId, hint) {
			// Invariant 1: a parked intent means the normal reap path is live.
			if (coordinator.peekIntent(runId) !== undefined) {
				firstMissAt.delete(runId);
				return;
			}
			const nowMs = now().getTime();
			const first = firstMissAt.get(runId);
			if (first === undefined) {
				firstMissAt.set(runId, nowMs);
				return;
			}
			// Invariant 2: the healthy path gets the whole grace window.
			if (nowMs - first < graceMs) return;
			// Invariant 3: never stack a second reap on the pod's poll cadence.
			if (inFlight.has(runId)) return;
			inFlight.add(runId);
			void recover(runId, hint).catch((err) => {
				bindBridgeLogger(deps.logger, { run_id: runId }).error(
					{
						event: "reap.finalize_recovery_failed",
						err: err instanceof Error ? err.message : String(err),
					},
					"finalize recovery reap failed; the pod's next poll re-arms the trigger",
				);
			});
		},
		drivenCount: () => driven,
	};
}

/** `true` only while the pod exists AND is still `Running` (the finalize-entrypoint wait). */
async function podIsLive(provider: RuntimeProvider, run: RunRow): Promise<boolean> {
	const handle: RunHandle = {
		runId: run.id,
		sandboxId: run.sandboxId as string, // caller guards non-null
		providerRunId: run.sandboxRunId ?? "",
	};
	try {
		const status = await provider.status(handle);
		return status.exists && status.phase === "running";
	} catch {
		return false;
	}
}

interface ClassifiedOutcome {
	readonly outcome: RunTerminalState;
	readonly source: FinalizeRecoveryOutcomeSource;
}

/**
 * Pick the recovery reap's outcome (invariant 5): the pod-reported agent exit
 * code wins; then the persisted event log's newest terminal envelope (a
 * pre-hint pod's bridge may have persisted `agent_end` before dying); then a
 * `succeeded` default, bounded by reap's own misclassification nets. Never
 * `cancelled` — recovery is not a cancellation path.
 */
async function classifyOutcome(
	repos: Repos,
	runId: string,
	hint: FinalizeIntentMissHint | undefined,
): Promise<ClassifiedOutcome> {
	if (hint?.agentExitCode !== undefined) {
		return {
			outcome: hint.agentExitCode === 0 ? "succeeded" : "failed",
			source: "agent_exit_hint",
		};
	}
	const tail = await repos.events.listTail(runId, TERMINAL_SCAN_TAIL);
	for (let i = tail.length - 1; i >= 0; i -= 1) {
		const row = tail[i];
		if (row === undefined) continue;
		const outcome = detectRuntimeTerminal({
			seq: row.sandboxEventSeq,
			ts: row.ts,
			kind: row.kind,
			stream: row.stream,
			payload: row.payloadJson,
		});
		if (outcome === "succeeded" || outcome === "failed") {
			return { outcome, source: "event_log" };
		}
	}
	return { outcome: "succeeded", source: "default" };
}

async function emitRecoveryEvent(
	deps: FinalizeRecoveryDeps,
	run: RunRow,
	classified: ClassifiedOutcome,
	now: Date,
): Promise<void> {
	const seq = ((await deps.repos.events.maxSeqForRun(run.id)) ?? 0) + 1;
	const row = await deps.repos.events.append({
		runId: run.id,
		sandboxEventSeq: seq,
		ts: now.toISOString(),
		kind: FINALIZE_RECOVERY_KIND,
		stream: "system",
		payload: {
			outcome: classified.outcome,
			source: classified.source,
			sandboxRunId: run.sandboxRunId,
		},
	});
	deps.broker?.publish(run.id, row);
}

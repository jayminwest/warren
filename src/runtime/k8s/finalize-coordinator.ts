/**
 * In-process correlation registry for the K8s finalize callback (pl-829f step
 * 20 / warren-0d35).
 *
 * `K8sProvider.finalize()` and the two finalize HTTP endpoints
 * (`GET /runs/:id/finalize-intent`, `POST /runs/:id/finalize-result`) run in the
 * SAME warren process but reach each other only through this shared object:
 *
 *   - `finalize()` calls `register(runId, intent)` — parks a pending entry and
 *     gets back a promise that resolves when the pod POSTs its result.
 *   - `GET /finalize-intent` calls `peekIntent(runId)` — serves the parked intent
 *     to the polling in-pod harness (once the agent has exited).
 *   - `POST /finalize-result` calls `submit(runId, attemptId, result)` — resolves
 *     the parked promise; `finalize()` wakes and returns the result to reap.
 *
 * ## Why in-memory (not a `run_finalize` table)
 *
 * Unlike `run_inbox` (step 18, a durable one-way queue drained by poll), finalize
 * is a short-lived request/response bracketed by a single `finalize()` await at
 * reap. Warren runs `replicas: 1` (design §1.1), so both sides are the same
 * process; an event-driven in-memory deferred is lower-latency than DB polling
 * and needs no migration. The tradeoff — a warren restart mid-finalize loses the
 * parked promise — is bounded: the run is recovered by the watchdog/reconcile
 * path, and `finalize()` is idempotent to re-drive. DB-backing is a step-26
 * hardening item if multi-replica warren ever lands (see the migration plan).
 *
 * ## Correlation + idempotency
 *
 * Entries are keyed by `runId` (one live finalize per run — the domain calls
 * `finalize` then `terminate`, never two concurrent finalizes for a run). Each
 * carries a unique `attemptId`; `submit` requires an exact `attemptId` match so a
 * stale attempt's late POST can't resolve a fresh one. A duplicate POST for an
 * already-settled attempt is a no-op `"duplicate"` (redelivery-safe), and a POST
 * with no matching entry is `"unknown"` — both let the endpoint answer 200 so the
 * pod's retry loop stops cleanly.
 */

import { generateId } from "../../core/ids.ts";
import type { FinalizeResult } from "../contract.ts";
import type { InPodFinalizeIntent } from "./finalize-wire.ts";

/** Outcome of a `submit` — the endpoint maps every case onto an idempotent 200. */
export type FinalizeSubmitOutcome = "accepted" | "duplicate" | "stale" | "unknown";

/** Handle `register` hands back to `finalize()`. */
export interface PendingFinalize {
	/** The attempt id embedded in the served intent + expected on the result POST. */
	readonly attemptId: string;
	/**
	 * Resolves when the in-pod harness POSTs its result (via `submit`). Never
	 * rejects — `finalize()` owns the timeout/pod-gone races and calls `abort`.
	 */
	readonly result: Promise<FinalizeResult>;
}

interface Entry {
	attemptId: string;
	intent: InPodFinalizeIntent;
	resolve: (r: FinalizeResult) => void;
	settled: boolean;
}

export class FinalizeCoordinator {
	private readonly byRun = new Map<string, Entry>();

	/**
	 * Park a pending finalize for `runId` and return the awaitable result. Stamps
	 * a fresh `attemptId` INTO the stored intent (the served copy carries it) so
	 * the result POST correlates. If a stale entry already exists for the run
	 * (a prior finalize that never settled), it is dropped — the newest attempt
	 * wins, and the old awaiter is left to its own timeout.
	 */
	register(runId: string, intent: Omit<InPodFinalizeIntent, "attemptId">): PendingFinalize {
		const attemptId = generateId("finalizeAttempt");
		const fullIntent: InPodFinalizeIntent = { ...intent, attemptId };
		let resolve!: (r: FinalizeResult) => void;
		const result = new Promise<FinalizeResult>((res) => {
			resolve = res;
		});
		this.byRun.set(runId, { attemptId, intent: fullIntent, resolve, settled: false });
		return { attemptId, result };
	}

	/**
	 * The parked intent for `runId`, or `undefined` when none is pending (or it
	 * already settled). Served by `GET /runs/:id/finalize-intent` to the polling
	 * harness.
	 */
	peekIntent(runId: string): InPodFinalizeIntent | undefined {
		const entry = this.byRun.get(runId);
		return entry !== undefined && !entry.settled ? entry.intent : undefined;
	}

	/**
	 * Deliver a result for `runId`. Requires an exact `attemptId` match (`"stale"`
	 * otherwise). First matching delivery resolves the parked promise
	 * (`"accepted"`); a repeat is a redelivery no-op (`"duplicate"`); no entry is
	 * `"unknown"`. Every case is safe for the endpoint to 200.
	 */
	submit(runId: string, attemptId: string, result: FinalizeResult): FinalizeSubmitOutcome {
		const entry = this.byRun.get(runId);
		if (entry === undefined) return "unknown";
		if (entry.attemptId !== attemptId) return "stale";
		if (entry.settled) return "duplicate";
		entry.settled = true;
		entry.resolve(result);
		return "accepted";
	}

	/**
	 * Drop the pending entry for `runId` — called by `finalize()` after it
	 * resolves, times out, or detects the pod is gone, so a late POST for a dead
	 * attempt is a clean `"unknown"`. Idempotent. Only removes the entry when its
	 * `attemptId` matches, so aborting a stale attempt can't evict a newer one.
	 */
	abort(runId: string, attemptId: string): void {
		const entry = this.byRun.get(runId);
		if (entry !== undefined && entry.attemptId === attemptId) this.byRun.delete(runId);
	}

	/** Count of live pending entries — test/observability helper. */
	get pendingCount(): number {
		return this.byRun.size;
	}
}

/**
 * Process-wide shared coordinator. `K8sProvider.finalize()` and the finalize
 * endpoints default to THIS instance so they correlate without threading it
 * through every `resolveRuntimeProvider` call site (steer/cancel build their own
 * providers per request, but never finalize). Tests inject a private instance
 * into both sides to assert correlation in isolation.
 */
export const sharedFinalizeCoordinator = new FinalizeCoordinator();

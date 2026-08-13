/**
 * The finalize callback endpoints for the K8s backend (pl-829f step 20 /
 * warren-0d35) — the control-plane half of the in-pod reap.
 *
 * The run pod's `emptyDir` workspace is unreachable from warren, so the
 * workspace-dependent half of reap (contract §4 `finalize`) runs INSIDE the pod
 * and talks to warren over these two authenticated routes (step 17's decision:
 * finalize deltas ride the HTTP callback, not the NDJSON log stream):
 *
 *   - `GET /runs/:id/finalize-intent` — the in-pod harness polls this (after the
 *     agent exits) to fetch the finalize INTENT `K8sProvider.finalize()` parked
 *     with the coordinator. `{ intent: null }` until warren has one; the intent
 *     object once reap is driving finalize.
 *   - `POST /runs/:id/finalize-result` — the harness POSTs its collected
 *     `FinalizeResult` here; the coordinator resolves the awaiting `finalize()`.
 *     Idempotent: a duplicate / stale / unknown POST still answers 200 so the
 *     pod's retry loop stops (see `FinalizeCoordinator`).
 *
 * Both are bearer-gated like every other `/runs` route — the pod carries the
 * per-run SCOPED callback token warren injected at create (warren-57fd), which
 * authorizes exactly this run's inbox + finalize surface and nothing else.
 * Neither is auth-exempt.
 *
 * The coordinator is the process-wide `sharedFinalizeCoordinator` by default (the
 * same instance `K8sProvider.finalize()` defaults to, so they correlate without
 * boot wiring); `deps.finalizeCoordinator` overrides it for tests.
 */

import type { FinalizeIntentMissHint } from "../../../runs/finalize-recovery.ts";
import { sharedFinalizeCoordinator } from "../../../runtime/k8s/finalize-coordinator.ts";
import { parseFinalizeResultEnvelope } from "../../../runtime/k8s/finalize-wire.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { readJsonBody, requireParam } from "../index.ts";

/**
 * Parse the pod-reported agent exit code off the intent poll's `?agent_exit=`
 * query param (warren-5202). `undefined` when absent (pre-hint pods) or
 * malformed — the recovery driver treats both as "no hint" and falls back to
 * the event-log scan. Never throws: a bad query param must not break the poll.
 */
export function parseAgentExitHint(url: URL): FinalizeIntentMissHint {
	const raw = url.searchParams.get("agent_exit");
	if (raw === null) return {};
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 255) return {};
	return { agentExitCode: n };
}

/**
 * `GET /runs/:id/finalize-intent` — serve the parked finalize intent to the
 * in-pod harness, or `{ intent: null }` when none is pending yet (the harness
 * keeps polling). The intent already carries its `attemptId` — the correlation
 * key the harness echoes on its result POST.
 *
 * warren-5202: an intent MISS is also the recovery signal. After a
 * control-plane replacement the in-memory coordinator is empty and the lost
 * reap will never park again, so the pod's poll is the only signal that
 * survives the restart. Each miss is reported to the boot-wired
 * `deps.finalizeRecovery` hook (K8s topology only), which re-drives reap once
 * the miss outlives its grace. Fire-and-forget: the poll response never waits
 * on recovery, and the GET appends no run event (it must not reset the
 * heartbeat watchdog's anchor).
 */
export function getRunFinalizeIntentHandler(deps: ServerDeps): RouteHandler {
	const coordinator = deps.finalizeCoordinator ?? sharedFinalizeCoordinator;
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const intent = coordinator.peekIntent(id);
		if (intent === undefined) {
			deps.finalizeRecovery?.onIntentMiss(id, parseAgentExitHint(ctx.url));
		}
		return jsonResponse(200, { intent: intent ?? null });
	};
}

/**
 * `POST /runs/:id/finalize-result` — intake for the in-pod harness's collected
 * `FinalizeResult`. Validates the envelope (a malformed body is a 400 the harness
 * can retry), then hands it to the coordinator keyed by `runId` + `attemptId`.
 * The `outcome` (`accepted` | `duplicate` | `stale` | `unknown`) is echoed so the
 * harness can log it; every case is a 200 because redelivery must be safe.
 */
export function postRunFinalizeResultHandler(deps: ServerDeps): RouteHandler {
	const coordinator = deps.finalizeCoordinator ?? sharedFinalizeCoordinator;
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const envelope = parseFinalizeResultEnvelope(body);
		const outcome = coordinator.submit(id, envelope.attemptId, envelope.result);
		return jsonResponse(200, { outcome });
	};
}

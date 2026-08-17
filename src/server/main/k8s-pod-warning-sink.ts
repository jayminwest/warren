/**
 * Run-stream sink for K8s pod warning signals (warren-32f8). The
 * `PodEventWatcher` (`src/runtime/k8s/pod-event-watcher.ts`) observes core v1
 * Warning events for run pods — `FailedAttachVolume`, `FailedScheduling`,
 * image-pull backoffs, and similar waiting/stall causes that pod STATUS cannot
 * express — and this sink appends each deduplicated signal onto the run's own
 * event stream, so `GET /runs/:id/events` and the UI timeline show "pod wedged
 * on infrastructure" instead of a bare `queued` with an empty stream.
 *
 * Mirrors the watchdog-reconcile append pattern
 * (`src/runs/watchdog-reconcile.ts`): seq off `maxSeqForRun`, `system` stream,
 * structured payload, then `broker.publish` so live subscribers see it. The
 * watcher already dedupes per event object, so this sink appends exactly once
 * per distinct pod condition.
 *
 * The sink is fire-and-forget (the watcher's `onWarning` is synchronous):
 * failures — a run row already deleted, a transient DB error — are warn-logged
 * and swallowed so a surfacing hiccup can never wedge the informer loop.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RunEventBroker } from "../../runs/events.ts";
import type { PodWarningSignal } from "../../runtime/k8s/pod-event-watcher.ts";
import type { Logger } from "../types.ts";

/** Event kind recorded on the run's stream for a pod warning (warren-32f8). */
export const K8S_POD_WARNING_KIND = "k8s.pod_warning";

export interface PodWarningSinkDeps {
	readonly repos: Repos;
	readonly broker?: RunEventBroker;
	readonly logger: Logger;
	readonly now?: () => Date;
}

/** Build the `onPodWarning` callback `bootK8sRuntime` threads to the watcher. */
export function makePodWarningRunEventSink(
	deps: PodWarningSinkDeps,
): (signal: PodWarningSignal) => void {
	return (signal) => {
		void appendPodWarning(deps, signal).catch((err) => {
			deps.logger.warn(
				{ runId: signal.runId, reason: signal.reason, err: String(err) },
				"k8s pod warning sink failed to append run event",
			);
		});
	};
}

async function appendPodWarning(deps: PodWarningSinkDeps, signal: PodWarningSignal): Promise<void> {
	// A pod the warren DB no longer knows (reaped between the watcher's cache
	// lookup and this append, or a stale cache entry) has no stream to append
	// to — skip silently; the warn-log line in the watcher already recorded it.
	const run = await deps.repos.runs.get(signal.runId);
	if (run === null) return;
	const now = deps.now ?? (() => new Date());
	const seq = ((await deps.repos.events.maxSeqForRun(signal.runId)) ?? 0) + 1;
	const row = await deps.repos.events.append({
		runId: signal.runId,
		sandboxEventSeq: seq,
		ts: now().toISOString(),
		kind: K8S_POD_WARNING_KIND,
		stream: "system",
		payload: {
			reason: signal.reason,
			message: signal.message,
			podName: signal.podName,
			...(signal.podPhase !== undefined ? { podPhase: signal.podPhase } : {}),
			...(signal.eventName !== undefined ? { eventName: signal.eventName } : {}),
			count: signal.count,
			...(signal.firstTimestamp !== undefined ? { firstTimestamp: signal.firstTimestamp } : {}),
			...(signal.lastTimestamp !== undefined ? { lastTimestamp: signal.lastTimestamp } : {}),
		},
	});
	deps.broker?.publish(signal.runId, row);
}

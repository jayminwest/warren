/**
 * Pod-warning-events watcher for the K8s runtime backend (warren-32f8).
 *
 * The incident: a run's pod sat 17 minutes in `Init:0/1` on
 * `FailedAttachVolume` while the warren run read `queued` with an empty event
 * stream — an operator could not distinguish "waiting for a worker" from "pod
 * wedged on infrastructure". Pod STATUS alone cannot express that stall (the
 * container just waits in the benign-looking `ContainerCreating`); the cause
 * lives only on the core v1 Event stream (`FailedAttachVolume`,
 * `FailedScheduling`, `Failed` image pulls, `BackOff`, …).
 *
 * This watcher runs a second `ListWatchLoop` (the shared machinery in
 * `./list-watch.ts`) over `/api/v1/namespaces/<ns>/events` with a server-side
 * `type=Warning` field selector, correlates each event's
 * `involvedObject.name` back to a warren run id through the pod-watcher's
 * cache (the pod name is DNS-1123-sanitized and cannot be reversed; the
 * verbatim run id lives only on the pod label), and hands a structured
 * `PodWarningSignal` to the injected sink. The boot wiring
 * (`src/server/main/runtime-wiring.ts` + the run-stream sink) appends that
 * signal to the run's event stream so `GET /runs/:id/events` and the UI
 * timeline show the stall.
 *
 * ## Dedupe (transition, not flood)
 * The kubelet re-fires the same condition for minutes — the SAME Event object,
 * its `count` climbing (a 17-minute `FailedAttachVolume` is one object with
 * count in the dozens). Emitting per delivery would flood the run stream, so
 * each event is emitted exactly ONCE, keyed by its `metadata.uid` (falling
 * back to `metadata.name`). A watch reconnect / 410-relist re-delivers the
 * live page through the same dedupe, so recovery cannot re-flood either. A
 * genuinely NEW condition is a NEW event object (new uid) and emits again.
 * Seen-uids are pruned past `SEEN_UID_CAP` so a long-lived control plane does
 * not grow the set without bound.
 *
 * Normal-cause events (`Scheduled`, `Pulled`, `Created`, `Started`) are
 * `type: Normal` and never reach this watcher — a healthy startup emits
 * nothing.
 */

import type { CoreV1Event } from "@kubernetes/client-node";
import { type ListFn, type ListWatchFn, ListWatchLoop, type WatchPhase } from "./list-watch.ts";

/** The event-typed watch seam. */
export type EventWatchFn = ListWatchFn<CoreV1Event>;

/** Lists the current warning events — one page is assumed (run namespace is small). */
export type EventListFn = ListFn<CoreV1Event>;

/**
 * One deduplicated pod warning, ready to append to the run's event stream.
 * Payload mirrors the issue's structured requirement: reason, (truncated)
 * message, pod phase, timestamp.
 */
export interface PodWarningSignal {
	readonly runId: string;
	/** The event's machine reason — `FailedAttachVolume`, `FailedScheduling`, … */
	readonly reason: string;
	/** The event's human message, truncated to `maxMessageLength`. */
	readonly message: string;
	readonly podName: string;
	/** The pod's phase at signal time, when the pod cache knows it. */
	readonly podPhase?: string;
	/** K8s event object name (stable identity for support correlation). */
	readonly eventName?: string;
	/** How many times the kubelet had fired this condition at first sight. */
	readonly count: number;
	/** First / last fire timestamps from the event object (ISO strings). */
	readonly firstTimestamp?: string;
	readonly lastTimestamp?: string;
}

export interface PodEventWatcherDeps {
	readonly list: EventListFn;
	readonly watch: EventWatchFn;
	/** `warren-runs` namespace the watch path is built for. */
	readonly namespace: string;
	/**
	 * Correlate an event's `involvedObject.name` (a pod name) back to the warren
	 * run id — wired to `PodWatcher.runIdForPodName` at boot. Events for pods
	 * the pod cache does not know (foreign pods in the namespace, or a pod that
	 * was GC'd before its event arrived) are dropped.
	 */
	readonly runIdForPodName: (podName: string) => string | undefined;
	/** Optional pod-phase lookup for the signal payload (`PodWatcher.getByRunId`). */
	readonly podPhaseForRunId?: (runId: string) => string | undefined;
	/** The sink — boot wires this to append onto the run's event stream. */
	readonly onWarning: (signal: PodWarningSignal) => void;
	/** Backoff floor / ceiling for reconnects (ms). Defaults 1s / 30s. */
	readonly backoffBaseMs?: number;
	readonly backoffMaxMs?: number;
	/** Periodic force-relist cadence (ms); `0` disables. Default 5 min. */
	readonly resyncPeriodMs?: number;
	/** Message truncation budget. Default `DEFAULT_MAX_MESSAGE_LENGTH`. */
	readonly maxMessageLength?: number;
	readonly logger?: {
		info?: (obj: unknown, msg: string) => void;
		warn?: (obj: unknown, msg: string) => void;
	};
}

/** Structured-payload message budget — long kubelet messages are clipped. */
export const DEFAULT_MAX_MESSAGE_LENGTH = 500;

/**
 * Bound on the dedupe set. Events age out of the API after ~1h, so their uids
 * can never collide with fresh ones; past the cap the oldest entries are
 * dropped (Map insertion order), bounding memory on a long-lived process.
 */
const SEEN_UID_CAP = 10_000;

/**
 * The warning-events informer. Same lifecycle as `PodWatcher`: construct with
 * injected seams, `start()` to seed + watch, `stop()` to abort.
 */
export class PodEventWatcher {
	/** Event uids (fallback: event object names) already emitted — emit once each. */
	private readonly seen = new Set<string>();
	private readonly loop: ListWatchLoop<CoreV1Event>;

	constructor(private readonly deps: PodEventWatcherDeps) {
		this.loop = new ListWatchLoop<CoreV1Event>({
			label: "pod-event-watch",
			path: `/api/v1/namespaces/${deps.namespace}/events`,
			query: { fieldSelector: "type=Warning", allowWatchBookmarks: true },
			list: deps.list,
			watch: deps.watch,
			onRelist: (items) => this.handleRelist(items),
			onEvent: (phase, obj) => this.handleEvent(phase, obj),
			...(deps.backoffBaseMs !== undefined ? { backoffBaseMs: deps.backoffBaseMs } : {}),
			...(deps.backoffMaxMs !== undefined ? { backoffMaxMs: deps.backoffMaxMs } : {}),
			...(deps.resyncPeriodMs !== undefined ? { resyncPeriodMs: deps.resyncPeriodMs } : {}),
			...(deps.logger !== undefined ? { logger: deps.logger } : {}),
		});
	}

	/** Begin watching. Idempotent — a second call while running is a no-op. */
	start(): void {
		this.loop.start();
	}

	/** Abort the watch and await the loop's exit. Idempotent. */
	async stop(): Promise<void> {
		await this.loop.stop();
	}

	/**
	 * A relist re-delivers the live event page; run each item through the same
	 * dedupe as a watch event so a 410-relist / periodic resync cannot re-flood
	 * signals already emitted before the reconnect.
	 */
	private handleRelist(items: CoreV1Event[]): void {
		for (const event of items) this.consider(event);
	}

	private handleEvent(phase: WatchPhase, obj: CoreV1Event): void {
		// DELETED deliveries are just the object aging out of the API — nothing
		// to surface (the warning itself was emitted when first seen).
		if (phase === "DELETED") return;
		this.consider(obj);
	}

	/** Emit one signal per distinct warning event object, for known run pods. */
	private consider(event: CoreV1Event): void {
		const involved = event.involvedObject;
		if (involved?.kind !== "Pod") return;
		const podName = involved.name;
		if (podName === undefined || podName === "") return;
		const key = event.metadata?.uid ?? event.metadata?.name;
		if (key === undefined || this.seen.has(key)) return;
		const runId = this.deps.runIdForPodName(podName);
		if (runId === undefined) return;
		this.remember(key);
		const reason = event.reason ?? "Unknown";
		const signal: PodWarningSignal = {
			runId,
			reason,
			message: truncate(
				event.message ?? "",
				this.deps.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH,
			),
			podName,
			...(this.deps.podPhaseForRunId !== undefined
				? optionalField("podPhase", this.deps.podPhaseForRunId(runId))
				: {}),
			...(event.metadata?.name !== undefined ? { eventName: event.metadata.name } : {}),
			count: event.count ?? 1,
			...optionalField("firstTimestamp", isoOf(event.firstTimestamp)),
			...optionalField("lastTimestamp", isoOf(event.lastTimestamp)),
		};
		this.deps.logger?.warn?.({ runId, reason, podName }, "run pod warning event observed");
		this.deps.onWarning(signal);
	}

	private remember(key: string): void {
		this.seen.add(key);
		if (this.seen.size > SEEN_UID_CAP) {
			const oldest = this.seen.values().next().value;
			if (oldest !== undefined) this.seen.delete(oldest);
		}
	}
}

function truncate(message: string, max: number): string {
	return message.length <= max ? message : `${message.slice(0, max)}…`;
}

/** Spreadable `{ key: value }` or `{}` — strict optional-property typing. */
function optionalField<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
	return value === undefined ? {} : { [key]: value };
}

/** Event timestamps arrive as `Date` or string depending on the client parse. */
function isoOf(value: Date | string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value instanceof Date ? value.toISOString() : value;
}

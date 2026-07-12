/**
 * Pod garbage-collection loop for the K8s runtime backend (pl-829f step 19 /
 * warren-31d4, design k8s-migration.md R6). Pod logs are retained only until the
 * pod is deleted, and `restartPolicy: Never` run pods are never reaped by K8s
 * itself — so without a GC, thousands of `Succeeded`/`Failed` pods (and their
 * seed ConfigMaps) accumulate. This loop bounds retention: it deletes terminal
 * pods older than a retention window (default 30 min) and reclaims their — and
 * any orphaned — seed ConfigMaps.
 *
 * ## Injectable seams (mirrors the pod-watcher, `./pod-watcher.ts`)
 * Like the pod-watcher, the GC takes its cluster access as injected functions
 * (`listPods` / `listConfigMaps` / `deletePod` / `deleteConfigMap`) rather than a
 * live `CoreV1Api`, so the sweep logic (age math, keep/delete partition, orphan
 * detection) is exercised against fakes with no cluster. Real construction wires
 * the seams to `CoreV1Api` (a `warren.io/run-id`-labelled list + force delete);
 * that wiring is provider-internal and booted alongside the pod-watcher when the
 * K8s backend is stood up (plan step 25/26) — same wiring gap the pod-watcher
 * documents. Nothing in this step constructs a live `PodGc`.
 *
 * ## Lifecycle (mirrors `PodWatcher.start()/stop()`)
 * `start()` is idempotent and kicks an immediate sweep, then repeats every
 * `intervalMs`. `stop()` is idempotent, aborts the inter-sweep sleep so it
 * returns promptly, and awaits the loop's exit. A sweep failure is logged and the
 * loop continues — GC is best-effort and must never wedge.
 *
 * ## Keep/delete partition (one list, two reclaim passes)
 * A single pod list drives both passes. A pod is DELETED when it is terminal
 * (`Succeeded`/`Failed`) AND older than the window; every other pod's run-id is
 * kept. ConfigMaps are then deleted iff their run-id is NOT in the keep set —
 * which reclaims BOTH the just-deleted old pods' ConfigMaps and truly orphaned
 * ConfigMaps whose pod already vanished, while sparing ConfigMaps of live or
 * terminal-but-young pods.
 */

import type { V1ConfigMap, V1Pod } from "@kubernetes/client-node";
import { METRIC_POD_GC_DELETIONS_TOTAL } from "./pod-metrics.ts";
import { LABEL_RUN_ID } from "./pod-spec.ts";
import type { CounterSink } from "./pod-watcher.ts";

/** Retention window: terminal pods older than this are GC'd (design R6). */
export const DEFAULT_GC_MAX_AGE_MS = 30 * 60 * 1000;
/** Cadence between GC sweeps. */
export const DEFAULT_GC_INTERVAL_MS = 5 * 60 * 1000;

/** Pod phases that make a run pod eligible for age-based GC (design R6). */
const TERMINAL_POD_PHASES = new Set(["Succeeded", "Failed"]);

export interface PodGcDeps {
	/** List the run pods (labelled `warren.io/run-id`) in the run namespace. */
	readonly listPods: () => Promise<V1Pod[]>;
	/** List the run ConfigMaps (labelled `warren.io/run-id`) in the run namespace. */
	readonly listConfigMaps: () => Promise<V1ConfigMap[]>;
	/** Force-delete a pod by name. Resolves cleanly on a 404 (already gone). */
	readonly deletePod: (name: string) => Promise<void>;
	/** Delete a ConfigMap by name. Resolves cleanly on a 404 (already gone). */
	readonly deleteConfigMap: (name: string) => Promise<void>;
	/** Shared counter registry — GC-deletion totals (`{resource}`-labelled). */
	readonly metrics?: CounterSink;
	/** Injected clock for age math. Default `() => new Date()`. */
	readonly now?: () => Date;
	/** Retention window in ms. Default 30 min (`DEFAULT_GC_MAX_AGE_MS`). */
	readonly maxAgeMs?: number;
	/** Sweep cadence in ms. Default 5 min (`DEFAULT_GC_INTERVAL_MS`). */
	readonly intervalMs?: number;
	readonly logger?: {
		info?: (obj: unknown, msg: string) => void;
		warn?: (obj: unknown, msg: string) => void;
	};
}

/** What one sweep reclaimed — returned so callers/tests can assert the reclaim. */
export interface GcSweepResult {
	podsDeleted: number;
	configMapsDeleted: number;
}

/**
 * Run one GC pass: delete terminal-and-old pods, then delete any ConfigMap whose
 * run is no longer represented by a kept pod. Pure w.r.t. the injected seams —
 * no timers, no loop — so every branch (young kept, running kept, old deleted,
 * orphan swept) is unit-testable. Individual delete failures are logged and
 * skipped so one bad resource never aborts the sweep.
 */
export async function sweepPodGc(deps: PodGcDeps): Promise<GcSweepResult> {
	const nowMs = (deps.now ?? (() => new Date()))().getTime();
	const maxAgeMs = deps.maxAgeMs ?? DEFAULT_GC_MAX_AGE_MS;
	const { toDelete, keepRunIds } = partitionPods(await deps.listPods(), nowMs, maxAgeMs);
	const podsDeleted = await reclaimPods(deps, toDelete);
	const configMapsDeleted = await reclaimConfigMaps(deps, keepRunIds);
	return { podsDeleted, configMapsDeleted };
}

/**
 * Partition a pod list into the terminal-and-old names to delete and the set of
 * run-ids to KEEP (live, or terminal-but-young) — whose ConfigMaps must survive.
 */
function partitionPods(
	pods: V1Pod[],
	nowMs: number,
	maxAgeMs: number,
): { toDelete: string[]; keepRunIds: Set<string> } {
	const keepRunIds = new Set<string>();
	const toDelete: string[] = [];
	for (const pod of pods) {
		const name = pod.metadata?.name;
		if (name !== undefined && isTerminalPod(pod) && terminalAgeMs(pod, nowMs) > maxAgeMs) {
			toDelete.push(name);
		} else {
			const runId = runIdOf(pod);
			if (runId !== undefined) keepRunIds.add(runId);
		}
	}
	return { toDelete, keepRunIds };
}

/** Delete each named pod, counting successes; log + skip individual failures. */
async function reclaimPods(deps: PodGcDeps, names: string[]): Promise<number> {
	let deleted = 0;
	for (const name of names) {
		try {
			await deps.deletePod(name);
			deleted++;
			deps.metrics?.increment(METRIC_POD_GC_DELETIONS_TOTAL, { resource: "pod" });
		} catch (err) {
			deps.logger?.warn?.({ pod: name, err: errText(err) }, "pod-gc pod delete failed");
		}
	}
	return deleted;
}

/**
 * Delete every labelled ConfigMap whose run-id is NOT in `keepRunIds` — reclaims
 * both just-deleted old pods' ConfigMaps and truly orphaned ones. Log + skip
 * individual failures.
 */
async function reclaimConfigMaps(deps: PodGcDeps, keepRunIds: Set<string>): Promise<number> {
	let deleted = 0;
	for (const cm of await deps.listConfigMaps()) {
		const name = cm.metadata?.name;
		if (name === undefined) continue;
		const runId = runIdOf(cm);
		if (runId !== undefined && keepRunIds.has(runId)) continue;
		try {
			await deps.deleteConfigMap(name);
			deleted++;
			deps.metrics?.increment(METRIC_POD_GC_DELETIONS_TOTAL, { resource: "configmap" });
		} catch (err) {
			deps.logger?.warn?.({ configMap: name, err: errText(err) }, "pod-gc configmap delete failed");
		}
	}
	return deleted;
}

/**
 * The GC loop. Construct with the injected seams, call `start()` to begin the
 * periodic sweep, `stop()` to end it. Idempotent + abortable, mirroring
 * `PodWatcher`.
 */
export class PodGc {
	private running = false;
	private loopDone: Promise<void> | undefined;
	/** Resolver that unparks the inter-sweep sleep so `stop()` returns promptly. */
	private wake: (() => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly deps: PodGcDeps) {}

	/** Begin sweeping. Idempotent — a second call while running is a no-op. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.loopDone = this.loop();
	}

	/** Stop sweeping and await the loop's exit. Idempotent. */
	async stop(): Promise<void> {
		this.running = false;
		this.wake?.();
		await this.loopDone?.catch(() => {});
		this.loopDone = undefined;
	}

	private async loop(): Promise<void> {
		while (this.running) {
			try {
				await sweepPodGc(this.deps);
			} catch (err) {
				this.deps.logger?.warn?.({ err: errText(err) }, "pod-gc sweep failed");
			}
			if (!this.running) break;
			await this.sleep(this.deps.intervalMs ?? DEFAULT_GC_INTERVAL_MS);
		}
	}

	/** Sleep `ms`, interruptible by `stop()` via the `wake` resolver. */
	private sleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = (): void => {
				if (this.timer !== undefined) clearTimeout(this.timer);
				this.timer = undefined;
				this.wake = undefined;
				resolve();
			};
			this.wake = done;
			this.timer = setTimeout(done, ms);
		});
	}
}

/** The `warren.io/run-id` label value — the run correlation key. */
function runIdOf(obj: V1Pod | V1ConfigMap): string | undefined {
	const value = obj.metadata?.labels?.[LABEL_RUN_ID];
	return value === undefined || value === "" ? undefined : value;
}

/** A run pod in a terminal pod phase (`Succeeded`/`Failed`). */
function isTerminalPod(pod: V1Pod): boolean {
	const phase = pod.status?.phase;
	return phase !== undefined && TERMINAL_POD_PHASES.has(phase);
}

/**
 * Milliseconds since the pod reached its terminal state: the most recent
 * container `terminated.finishedAt` across all containers, falling back to the
 * pod's `creationTimestamp`. `0` when neither anchor is present (an
 * un-ageable pod is never GC'd) or the anchor is in the future (clock skew).
 */
function terminalAgeMs(pod: V1Pod, nowMs: number): number {
	const anchor = latestFinishedAt(pod) ?? pod.metadata?.creationTimestamp;
	if (anchor === undefined) return 0;
	const ms = nowMs - toMs(anchor);
	return ms > 0 ? ms : 0;
}

/** The latest `terminated.finishedAt` across the pod's init + main containers. */
function latestFinishedAt(pod: V1Pod): Date | string | undefined {
	const statuses = [
		...(pod.status?.initContainerStatuses ?? []),
		...(pod.status?.containerStatuses ?? []),
	];
	let latest: Date | undefined;
	for (const cs of statuses) {
		const finished = cs.state?.terminated?.finishedAt;
		if (finished === undefined) continue;
		const d = finished instanceof Date ? finished : new Date(finished);
		if (Number.isNaN(d.getTime())) continue;
		if (latest === undefined || d.getTime() > latest.getTime()) latest = d;
	}
	return latest;
}

function toMs(value: Date | string): number {
	return (value instanceof Date ? value : new Date(value)).getTime();
}

function errText(err: unknown): string {
	if (err === undefined || err === null) return "";
	return err instanceof Error ? err.message : String(err);
}

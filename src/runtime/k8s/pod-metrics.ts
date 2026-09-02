/**
 * Prometheus metric names + shapes for the K8s pod-watcher (pl-829f step 16 /
 * warren-a7ff, design doc §5.2). Two families:
 *
 *   - **Counters** — monotonic process-lifetime totals fed through warren's
 *     shared `MetricsRegistry` (`../../observability/metrics-registry.ts`), so
 *     the existing `/metrics` handler renders them with no wiring change. The
 *     watcher `increment`s these as it observes events.
 *   - **Gauges** — point-in-time reads computed at scrape from the watcher's
 *     live pod cache (a `PodMetricsSnapshot`), the same "read live at scrape"
 *     posture the handler already uses for the runs-by-state / bridge gauges.
 *     `buildPodPhaseMetrics` turns a snapshot into the `PromMetric[]` the
 *     handler appends.
 *
 * Names track the design doc (§5.2) and warren's `warren_*` prefix convention.
 * The doc pencilled the two `_duration_seconds` metrics as histograms; warren's
 * dependency-free metrics core (`../../observability/prometheus.ts`) exposes
 * only gauge + counter, so they render as gauges — `pending_duration` the
 * longest currently-pending pod's age, `init_duration` the last observed
 * workspace-init container runtime. A histogram upgrade is a metrics-core change
 * out of this step's scope.
 */

import type { PromMetric } from "../../observability/prometheus.ts";

// --- Counter names (fed through the shared MetricsRegistry) -----------------

/** Total OOM kills observed across all run pods (`terminated.reason==OOMKilled`). */
export const METRIC_OOM_KILLED_TOTAL = "warren_run_oom_killed_total";
/**
 * Total pod evictions observed across all run pods (`status.reason==Evicted`,
 * warren-c0cd) — the kubelet reclaiming a pod under node resource pressure, most
 * often ephemeral-storage exhaustion. Counted once per run, alongside the
 * `evicted` terminalReason the run finalizes with, so a spike in evictions is
 * visible as an infra-capacity signal distinct from OOM kills.
 */
export const METRIC_EVICTED_TOTAL = "warren_run_evicted_total";
/**
 * Total Spot preemptions observed across all run pods (warren-ea4b) — the GKE
 * Spot node reclaimed out from under a running pod. Counted once per run,
 * alongside the `preempted` terminalReason the run finalizes with (a
 * retryable infra-lost cause), so a spike is visible as a capacity-reclamation
 * signal distinct from the eviction counter.
 */
export const METRIC_PREEMPTED_TOTAL = "warren_run_preempted_total";
/** Total pod-watch reconnects (watch stream ended and the informer re-attached). */
export const METRIC_WATCH_RECONNECTS_TOTAL = "warren_pod_watch_reconnects_total";
/** Total workspace-init container failures (init terminated with a non-zero exit). */
export const METRIC_INIT_FAILURES_TOTAL = "warren_workspace_init_failures_total";
/**
 * Total pod-log lines that failed to parse as an NDJSON event envelope during
 * `streamEvents` (pl-829f step 17 / warren-026c). A malformed / non-JSON line
 * (stray agent stdout, a truncated write) is dropped rather than killing the
 * stream; this counter makes that loss observable instead of silent.
 */
export const METRIC_LOG_PARSE_FAILURES_TOTAL = "warren_pod_log_parse_failures_total";
/**
 * Total resources reclaimed by the pod-GC loop (pl-829f step 19 / warren-31d4),
 * labelled `{resource}` (`pod` | `configmap`). The GC sweeps terminal pods older
 * than the retention window plus their (and orphaned) seed ConfigMaps to bound
 * log retention (design k8s-migration.md R6); this makes the reclaim observable.
 */
export const METRIC_POD_GC_DELETIONS_TOTAL = "warren_pod_gc_deletions_total";

// --- Gauge names (computed at scrape from the watcher cache) ----------------

/** Count of tracked run pods currently in each pod phase, labelled `{phase}`. */
export const METRIC_POD_PHASE = "warren_run_pod_phase";
/** Age (seconds) of the longest currently-`Pending` run pod; 0 when none pending. */
export const METRIC_POD_PENDING_DURATION = "warren_pod_pending_duration_seconds";
/** Last observed workspace-init container runtime (seconds); absent until one completes. */
export const METRIC_WORKSPACE_INIT_DURATION = "warren_workspace_init_duration_seconds";

/**
 * The gauge inputs the pod-watcher exposes for scrape-time rendering. A pure
 * value object so the `/metrics` handler stays free of watcher internals.
 */
export interface PodMetricsSnapshot {
	/** count of tracked pods per phase, e.g. `{ Pending: 2, Running: 5 }`. */
	readonly phaseCounts: Readonly<Record<string, number>>;
	/** age in seconds of the longest currently-`Pending` pod; 0 when none. */
	readonly pendingDurationSeconds: number;
	/** last observed workspace-init runtime in seconds, or `null` if none seen. */
	readonly lastInitDurationSeconds: number | null;
}

/** Anything the `/metrics` handler can pull a live pod-gauge snapshot from. */
export interface PodMetricsSource {
	metricsSnapshot(): PodMetricsSnapshot;
}

/**
 * Render a `PodMetricsSnapshot` into the Prometheus gauge families the handler
 * appends to the exposition. The phase gauge always emits (an empty
 * `phaseCounts` yields a family with no samples — a valid, zero-series gauge);
 * the init-duration gauge is omitted until a workspace-init has completed so the
 * series doesn't lie with a `0` before any clone ran.
 */
export function buildPodPhaseMetrics(snapshot: PodMetricsSnapshot): PromMetric[] {
	const metrics: PromMetric[] = [
		{
			name: METRIC_POD_PHASE,
			help: "Tracked run pods grouped by Kubernetes pod phase.",
			type: "gauge",
			samples: Object.keys(snapshot.phaseCounts)
				.sort()
				.map((phase) => ({ labels: { phase }, value: snapshot.phaseCounts[phase] ?? 0 })),
		},
		{
			name: METRIC_POD_PENDING_DURATION,
			help: "Age in seconds of the longest currently-Pending run pod (0 when none pending).",
			type: "gauge",
			samples: [{ value: snapshot.pendingDurationSeconds }],
		},
	];
	if (snapshot.lastInitDurationSeconds !== null) {
		metrics.push({
			name: METRIC_WORKSPACE_INIT_DURATION,
			help: "Runtime in seconds of the most recently completed workspace-init container.",
			type: "gauge",
			samples: [{ value: snapshot.lastInitDurationSeconds }],
		});
	}
	return metrics;
}

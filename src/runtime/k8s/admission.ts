/**
 * K8s-native admission control (pl-829f step 21 / warren-b6f2, design doc §3.3).
 * Supersedes the burrow-era postmortem items warren-b01e (capacity-aware
 * per-worker concurrency) and warren-ea4f (fail-fast on a dead worker): the
 * pod-per-run model makes fail-fast inherent (the pod-watcher sees `OOMKilled`
 * in ~1-2s), so warren keeps only the SOFT admission controls that sit in front
 * of the scheduler — it no longer sizes concurrency against host RAM.
 *
 * Three caps, all evaluated against pod counts the K8s API/pod-watcher already
 * exposes (no runs-table read — the pods ARE the queue in the pod-per-run
 * model), each producing a distinct HTTP 429 rejection:
 *
 *   1. **queue-depth** — total non-terminal run pods across the namespace
 *      (default 50). Bounds the work queue when the cluster is oversubscribed.
 *   2. **max-pending-pods** — run pods stuck in `Pending` phase (default 20). A
 *      large `Pending` count means the cluster can't schedule what it already
 *      has; adding more just extends the wait.
 *   3. **per-project concurrency** — non-terminal run pods for the dispatching
 *      project (default unlimited; per-project override via `.warren/config.yaml`
 *      `admission.maxConcurrentRuns`). Stops one active project starving others.
 *
 * The gate (`evaluateAdmission`) is a PURE function of counts × caps — the
 * provider's `create()` gathers the counts (from a wired pod-watcher snapshot,
 * or a cache-cold list-by-label) and applies it before creating the pod. A
 * rejection throws `RuntimeAdmissionError`, mapped to 429 (+ `Retry-After`) in
 * `src/server/errors.ts`.
 */

import type { V1Pod } from "@kubernetes/client-node";

/** Terminal pod phases — a pod here no longer consumes cluster capacity. */
const TERMINAL_POD_PHASES: ReadonlySet<string> = new Set(["Succeeded", "Failed"]);
/** The `Pending` phase string kubelet reports for an unscheduled/starting pod. */
const PENDING_POD_PHASE = "Pending";

/** Default queue-depth cap (total non-terminal run pods). `WARREN_K8S_MAX_QUEUE_DEPTH`. */
export const DEFAULT_MAX_QUEUE_DEPTH = 50;
/** Default max-pending-pods cap. `WARREN_K8S_MAX_PENDING_PODS`. */
export const DEFAULT_MAX_PENDING_PODS = 20;
/**
 * Retry-After (seconds) advertised on a 429. Cluster saturation clears on the
 * order of pod-schedule/finish latency, so a short backoff is honest — a long
 * one just wastes throughput once capacity frees.
 */
export const ADMISSION_RETRY_AFTER_SECONDS = 30;

/** Prometheus counter for admission rejections, labelled `{reason}`. */
export const METRIC_ADMISSION_REJECTIONS_TOTAL = "warren_run_admission_rejections_total";

/** The distinct reasons a dispatch is refused — the `Retry-After` 429 detail. */
export type AdmissionRejectReason =
	| "queue_depth_exceeded"
	| "cluster_pending_saturated"
	| "project_concurrency_exceeded";

/**
 * Resolved caps the gate enforces. A value `<= 0` (or absent per-project cap)
 * means UNLIMITED — the corresponding check is skipped, so an operator disables
 * a control by setting its knob to `0`.
 */
export interface AdmissionCaps {
	/** total non-terminal run pods; `<= 0` ⇒ unlimited. */
	readonly maxQueueDepth: number;
	/** `Pending` run pods; `<= 0` ⇒ unlimited. */
	readonly maxPendingPods: number;
	/** non-terminal run pods for the dispatching project; `null`/`<= 0` ⇒ unlimited. */
	readonly maxProjectConcurrency: number | null;
}

/** Point-in-time counts the gate reads, derived from the current run pods. */
export interface AdmissionCounts {
	/** run pods NOT in a terminal phase (Pending/Running/Unknown). */
	readonly nonTerminalPods: number;
	/** run pods currently in `Pending` phase. */
	readonly pendingPods: number;
	/** non-terminal run pods carrying the dispatching project's label. */
	readonly projectNonTerminalPods: number;
}

/** Gate verdict: admit, or reject with a machine-readable reason + backoff. */
export type AdmissionDecision =
	| { readonly admit: true }
	| {
			readonly admit: false;
			readonly reason: AdmissionRejectReason;
			readonly detail: string;
			readonly retryAfterSeconds: number;
	  };

/**
 * A live source of admission counts — implemented by the pod-watcher so
 * `create()` can read counts off the in-memory cache without an API round-trip.
 * Optional in the provider: absent, `create()` lists pods by label instead.
 */
export interface PodAdmissionSource {
	/** Snapshot the current run-pod counts for a given project. */
	admissionSnapshot(projectId: string | undefined): AdmissionCounts;
}

/** Minimal counter surface the admission metric is fed through (MetricsRegistry). */
export interface AdmissionCounterSink {
	increment(name: string, labels?: Readonly<Record<string, string>>, by?: number): void;
}

/** Env surface `resolveAdmissionCaps` reads (a subset of `process.env`). */
export type AdmissionEnv = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the caps from server env + the (already per-project-resolved) project
 * concurrency override. Global knobs (`WARREN_K8S_MAX_QUEUE_DEPTH`,
 * `WARREN_K8S_MAX_PENDING_PODS`) fall back to the `DEFAULT_*` constants; a blank,
 * non-numeric, or negative value is ignored (falls back), matching the
 * `pickNonNegativeInt` posture in `pod-spec.ts`. The per-project cap rides the
 * `RunSpec` (resolved at dispatch from `.warren/config.yaml`); a global default
 * (`WARREN_K8S_MAX_PROJECT_CONCURRENCY`) applies when the project sets none.
 */
export function resolveAdmissionCaps(
	env: AdmissionEnv,
	projectConcurrencyOverride?: number,
): AdmissionCaps {
	const globalProjectCap = readNonNegativeInt(env.WARREN_K8S_MAX_PROJECT_CONCURRENCY);
	const projectCap =
		projectConcurrencyOverride !== undefined && projectConcurrencyOverride > 0
			? projectConcurrencyOverride
			: (globalProjectCap ?? null);
	return {
		maxQueueDepth: readNonNegativeInt(env.WARREN_K8S_MAX_QUEUE_DEPTH) ?? DEFAULT_MAX_QUEUE_DEPTH,
		maxPendingPods: readNonNegativeInt(env.WARREN_K8S_MAX_PENDING_PODS) ?? DEFAULT_MAX_PENDING_PODS,
		maxProjectConcurrency: projectCap,
	};
}

/** True when every cap is unlimited — the provider can then skip counting. */
export function admissionDisabled(caps: AdmissionCaps): boolean {
	return (
		caps.maxQueueDepth <= 0 &&
		caps.maxPendingPods <= 0 &&
		(caps.maxProjectConcurrency === null || caps.maxProjectConcurrency <= 0)
	);
}

/**
 * Tally the admission-relevant counts from the current run pods. Pure — the
 * shared body behind both count sources (the pod-watcher's `admissionSnapshot`
 * and the provider's cache-cold list). A pod with no/unknown phase counts as
 * non-terminal (conservative: an unschedulable pod still holds a slot).
 */
export function countPodsForAdmission(
	pods: readonly V1Pod[],
	projectId: string | undefined,
	projectLabelKey: string,
): AdmissionCounts {
	let nonTerminalPods = 0;
	let pendingPods = 0;
	let projectNonTerminalPods = 0;
	const wantProject = projectId !== undefined && projectId !== "" ? projectId : undefined;
	for (const pod of pods) {
		const phase = pod.status?.phase ?? PENDING_POD_PHASE;
		if (TERMINAL_POD_PHASES.has(phase)) continue;
		nonTerminalPods += 1;
		if (phase === PENDING_POD_PHASE) pendingPods += 1;
		if (wantProject !== undefined && pod.metadata?.labels?.[projectLabelKey] === wantProject) {
			projectNonTerminalPods += 1;
		}
	}
	return { nonTerminalPods, pendingPods, projectNonTerminalPods };
}

/**
 * The pure gate: given counts + caps, admit or reject. Checks run
 * most-specific-first so the tightest applicable limit is reported: the
 * per-project cap (a single project hammering) before cluster-wide pending
 * saturation before the coarse queue-depth ceiling. A cap `<= 0`/`null` is
 * unlimited and skipped.
 */
export function evaluateAdmission(counts: AdmissionCounts, caps: AdmissionCaps): AdmissionDecision {
	const { maxProjectConcurrency, maxPendingPods, maxQueueDepth } = caps;
	if (
		maxProjectConcurrency !== null &&
		maxProjectConcurrency > 0 &&
		counts.projectNonTerminalPods >= maxProjectConcurrency
	) {
		return reject(
			"project_concurrency_exceeded",
			`project already has ${counts.projectNonTerminalPods} active run(s) (cap ${maxProjectConcurrency})`,
		);
	}
	if (maxPendingPods > 0 && counts.pendingPods >= maxPendingPods) {
		return reject(
			"cluster_pending_saturated",
			`${counts.pendingPods} run pods are Pending (cap ${maxPendingPods}); the cluster is oversubscribed`,
		);
	}
	if (maxQueueDepth > 0 && counts.nonTerminalPods >= maxQueueDepth) {
		return reject(
			"queue_depth_exceeded",
			`${counts.nonTerminalPods} run pods are active (queue-depth cap ${maxQueueDepth})`,
		);
	}
	return { admit: true };
}

function reject(reason: AdmissionRejectReason, detail: string): AdmissionDecision {
	return { admit: false, reason, detail, retryAfterSeconds: ADMISSION_RETRY_AFTER_SECONDS };
}

/**
 * Parse a non-negative integer env value. Blank/missing/non-numeric/negative/
 * non-integer ⇒ `undefined` (caller falls back to its default). `0` is a valid,
 * meaningful value (disables the cap), so it is returned, not treated as unset.
 */
function readNonNegativeInt(raw: string | undefined): number | undefined {
	const trimmed = raw?.trim();
	if (trimmed === undefined || trimmed === "") return undefined;
	const n = Number(trimmed);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

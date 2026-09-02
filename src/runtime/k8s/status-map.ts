/**
 * Pure pod → `RunStatus` mapping for the K8s runtime backend (pl-829f step 16 /
 * warren-a7ff). Reconciles a Kubernetes `V1Pod`'s phase + container states onto
 * the seam's coarse `RunStatus` (contract in `../contract.ts`). No cluster
 * access, no clock beyond what the caller injects — a pure function so every
 * phase × container-state combination is unit-testable without a cluster.
 *
 * ## Pod phase / container state → RunStatus mapping (design doc §1.3)
 *
 * | pod.status.phase | container discriminator                     | phase     | terminalReason | exitCode      |
 * |------------------|---------------------------------------------|-----------|----------------|---------------|
 * | (absent)         | pod just created, no status yet             | queued    | (none)         | null          |
 * | Pending          | scheduling / image pull / init running      | queued    | (none)         | null          |
 * | Running          | agent container running                     | running   | (none)         | null          |
 * | Succeeded        | agent terminated exit 0                     | succeeded | completed      | 0 (or agent)  |
 * | Failed           | any container terminated `OOMKilled`        | failed    | oom_killed     | 137 (or code) |
 * | Failed           | pod `status.reason == "Evicted"`            | failed    | evicted        | 137 / null    |
 * | Failed           | a container terminated exit≠0 (Init:Error)  | failed    | error          | that code     |
 * | Failed           | no failing container status                 | failed    | error          | null          |
 * | Unknown          | kubelet lost contact — NOT terminal         | running   | (none)         | null          |
 *
 * A `Failed` pod is ALWAYS terminal (warren-c0cd): whatever the container-status
 * shape — a clean non-zero exit, a `ContainerStatusUnknown` exit 137 (the kubelet
 * couldn't locate a container it already killed, the classic eviction footprint),
 * or no container status at all — the run terminalizes, never falling through to a
 * non-terminal state that leaves the run wedged `running`.
 *
 * A pod that is ABSENT from the API (list empty / 404) is not represented here:
 * the provider maps it to `runLostStatus()` (`exists:false` + `terminalReason:
 * "lost"`), mirroring LocalProvider's burrow-404 path (`../local/status.ts`).
 *
 * ### The OOM signal — fast-fail (design doc §3.2)
 * `restartPolicy: Never` means an OOMKilled agent container ends the pod in
 * `Failed` phase with `containerStatuses[].state.terminated.reason ==
 * "OOMKilled"`. The pod-watcher's informer surfaces this within ~1-2s, so the
 * run reaches `failed(oom_killed)` in seconds — the whole point of the migration
 * (replacing the 45-min heartbeat watchdog as the sole OOM backstop).
 *
 * ### `lastEventSeq` / `lastEventTs`
 * The warren event `seq` cursor is synthesized over pod logs by `streamEvents`
 * (step 17 / warren-026c); a pod's `.status` carries no such cursor, so this
 * mapping returns `lastEventSeq: 0`. `lastEventTs` is a best-effort heartbeat
 * anchor read off the pod's most recent container/state timestamp (the domain
 * still owns the watchdog decision; the authoritative resume cursor is warren's
 * own `maxSeqForRun`, which the run-state poller consults instead).
 *
 * CONFIRMED at step 17: `lastEventSeq` STAYS `0` by design. Synthesizing it here
 * would force a full pod-log replay on every `status()` poll (the seq is the log
 * line index — there is no cheap "latest seq" pod field), and NO consumer reads
 * it: the only reference is `run-state-poller.ts`, which explicitly does NOT
 * consume `status().lastEventSeq` and resumes off warren's persisted
 * `maxSeqForRun`. LocalProvider pays a burrow replay only because it collapses a
 * `maxSeqForRun` query burrow offers no lighter path for; K8s has no such reason.
 */

import type { V1ContainerStatus, V1Pod } from "@kubernetes/client-node";
import type { RunPhase, RunStatus, TerminalReason } from "../contract.ts";
import { AGENT_CONTAINER_NAME } from "./pod-spec.ts";

/** kubelet's `terminated.reason` for a cgroup OOM kill. */
const OOM_KILLED_REASON = "OOMKilled";

/**
 * The kubelet's pod-level `status.reason` for an eviction (warren-c0cd). Set when
 * a node reclaims a pod under resource pressure — most often ephemeral-storage
 * exhaustion (the emptyDir workspace overrunning its budget). The evicted pod
 * lingers in `Failed` phase; its container terminated state is usually
 * `{reason: "ContainerStatusUnknown", exitCode: 137}` (the runtime couldn't locate
 * the already-killed container), which is why the pod reason — not a container
 * reason — is the reliable eviction witness.
 */
const EVICTED_REASON = "Evicted";

/**
 * The kubelet's pod-level `status.reason` for a node-shutdown termination
 * (warren-ea4b): the kubelet terminates pods during graceful node shutdown /
 * cloud reclamation (a GKE Spot node being preempted) with reason `Terminated`
 * or `Shutdown` and a node-shutdown `status.message`.
 */
const PREEMPTED_POD_REASONS = new Set(["Terminated", "Shutdown"]);
/** The kubelet node-shutdown message carried on a preempted pod. */
const NODE_SHUTDOWN_MESSAGE = /shut(?:ting)? ?down/i;
/** The `DisruptionTarget` condition reason the kubelet stamps on preemption. */
const TERMINATION_BY_KUBELET = "TerminationByKubelet";
/** The node label GKE stamps on Spot (preemptible) nodes. */
export const GKE_SPOT_NODE_LABEL = "cloud.google.com/gke-spot";

/**
 * The reconcile snapshot for a run whose pod is ABSENT from the API — deleted,
 * GC'd, or evicted-and-gone (design doc §1.3 / contract §6.7). Reported as a
 * terminal `failed` so the domain stops waiting, tagged `lost` so it knows the
 * run vanished rather than failing on its own merits, `exists:false` so the
 * caller can branch on run-lost. Mirrors LocalProvider's burrow-404 mapping.
 */
export function runLostStatus(terminalReason: TerminalReason = "lost"): RunStatus {
	return {
		phase: "failed",
		exitCode: null,
		terminalReason,
		lastEventSeq: 0,
		lastEventTs: null,
		exists: false,
	};
}

/**
 * Map a present pod's phase + container states onto the seam's `RunStatus`.
 * Always `exists:true` (the pod is present); an absent pod is `runLostStatus()`.
 */
export function mapPodToRunStatus(pod: V1Pod): RunStatus {
	const phase = pod.status?.phase;
	const classified = classify(pod, phase);
	const terminalDetail = classified.terminalReason !== undefined ? kubeletDetail(pod) : null;
	return {
		phase: classified.phase,
		exitCode: classified.exitCode,
		...(classified.terminalReason !== undefined
			? { terminalReason: classified.terminalReason }
			: {}),
		...(terminalDetail !== null ? { terminalDetail } : {}),
		lastEventSeq: 0,
		lastEventTs: heartbeatAnchor(pod),
		exists: true,
	};
}

interface Classified {
	phase: RunPhase;
	exitCode: number | null;
	terminalReason?: TerminalReason;
}

function classify(pod: V1Pod, phase: string | undefined): Classified {
	switch (phase) {
		case "Succeeded":
			return { phase: "succeeded", exitCode: agentExitCode(pod) ?? 0, terminalReason: "completed" };
		case "Failed":
			return classifyFailed(pod);
		case "Running":
			return { phase: "running", exitCode: null };
		case "Unknown":
			// kubelet lost contact with the node. NOT terminal — the pod may still be
			// running; leave it `running` and let the domain watchdog reclaim a
			// genuinely-stuck run (design doc §3.2 keeps the watchdog as the
			// disappear-from-API backstop).
			return { phase: "running", exitCode: null };
		default:
			// Pending, or a just-created pod with no `.status.phase` yet: the agent
			// container has not started (image pull, scheduling, or the workspace-init
			// init container is still materializing). The coarse honest state is
			// `queued` — the agent workload has not begun (design doc §1.3).
			return { phase: "queued", exitCode: null };
	}
}

/**
 * Split a `Failed` pod on its pod reason + container terminated states. Order is
 * significant, most-specific first:
 *
 *   1. an OOM kill anywhere (agent OR init `terminated.reason == "OOMKilled"`) is
 *      first-class `oom_killed`;
 *   2. a kubelet EVICTION (`pod.status.reason == "Evicted"`) is first-class
 *      `evicted` — checked BEFORE the generic non-zero path because an evicted
 *      pod's container typically terminates `ContainerStatusUnknown` exit 137,
 *      which would otherwise be mis-labelled a plain `error` (warren-c0cd);
 *   3. any other non-zero container termination (incl. `ContainerStatusUnknown`
 *      exit 137 on a non-evicted pod, e.g. a crash) is `error` with its exit code;
 *   4. a `Failed` pod with no failing terminated container is still `error` (null
 *      exit) — never a non-terminal fall-through: a `Failed` pod ALWAYS terminates
 *      the run.
 */
function classifyFailed(pod: V1Pod): Classified {
	const terminated = allContainerStatuses(pod)
		.map((cs) => cs.state?.terminated ?? cs.lastState?.terminated)
		.filter((t): t is NonNullable<typeof t> => t !== undefined && t !== null);

	const oom = terminated.find((t) => t.reason === OOM_KILLED_REASON);
	if (oom !== undefined) {
		return { phase: "failed", exitCode: oom.exitCode ?? null, terminalReason: "oom_killed" };
	}
	if (pod.status?.reason === EVICTED_REASON) {
		// Prefer the agent's exit code (137 on the classic ephemeral-storage
		// eviction), else the first non-zero terminated code, else null.
		const exitCode =
			agentExitCode(pod) ?? terminated.find((t) => t.exitCode !== 0)?.exitCode ?? null;
		return { phase: "failed", exitCode, terminalReason: "evicted" };
	}
	// warren-ea4b: a Spot/node-shutdown preemption is checked BEFORE the generic
	// non-zero path — a preempted pod's container typically terminates
	// `ContainerStatusUnknown` exit 137, which would otherwise be mis-labelled a
	// plain `error`.
	if (isPreemptedPod(pod)) {
		const exitCode =
			agentExitCode(pod) ?? terminated.find((t) => t.exitCode !== 0)?.exitCode ?? null;
		return { phase: "failed", exitCode, terminalReason: "preempted" };
	}
	const nonZero = terminated.find((t) => t.exitCode !== 0);
	if (nonZero !== undefined) {
		return { phase: "failed", exitCode: nonZero.exitCode ?? null, terminalReason: "error" };
	}
	// Failed phase but no failing terminated container (lost node, etc.). Still
	// terminal — a Failed pod never leaves the run `running`.
	return { phase: "failed", exitCode: null, terminalReason: "error" };
}

/**
 * Pure preemption witness (warren-ea4b). A pod was PREEMPTED when its kubelet
 * terminated it for a node shutdown / cloud reclamation — any of:
 *
 *   - `status.reason` `Terminated` or `Shutdown` with the kubelet node-shutdown
 *     message (`The node is shutting down`);
 *   - a `DisruptionTarget` condition with reason `TerminationByKubelet` — the
 *     kubelet's own disruption marker for a workload it terminated outside the
 *     workload's fault (GKE Spot reclamation rides this).
 *
 * The third witness — the pod VANISHING while its (spot-labelled) node was
 * deleted — needs cluster state the pure map cannot see, so the pod-watcher /
 * provider surface it separately (see `PodWatcher.wasPreempted`).
 */
export function isPreemptedPod(pod: V1Pod): boolean {
	const reason = pod.status?.reason;
	if (
		reason !== undefined &&
		PREEMPTED_POD_REASONS.has(reason) &&
		NODE_SHUTDOWN_MESSAGE.test(pod.status?.message ?? "")
	) {
		return true;
	}
	return (pod.status?.conditions ?? []).some(
		(c) => c.type === "DisruptionTarget" && c.reason === TERMINATION_BY_KUBELET,
	);
}

/**
 * The kubelet's own explanation of a terminal pod (warren-4a95):
 * `status.message` (e.g. `Pod ephemeral local storage usage exceeds the total
 * limit of containers 10Gi` on an eviction), falling back to `status.reason`
 * when the message is absent, `null` when neither is set. The evicted pod —
 * and its kubectl events — age out of the API within the hour, so this detail
 * must be captured into warren's run record at reconcile time or the eviction
 * cause is undiagnosable after the fact.
 */
function kubeletDetail(pod: V1Pod): string | null {
	const message = pod.status?.message?.trim();
	if (message !== undefined && message !== "") return message;
	const reason = pod.status?.reason?.trim();
	if (reason !== undefined && reason !== "") return reason;
	return null;
}

/** The agent container's terminated exit code, if it has terminated. */
function agentExitCode(pod: V1Pod): number | null {
	const agent = agentContainerStatus(pod);
	const term = agent?.state?.terminated ?? agent?.lastState?.terminated;
	return term?.exitCode ?? null;
}

/** The agent container's status row (by the well-known `AGENT_CONTAINER_NAME`). */
export function agentContainerStatus(pod: V1Pod): V1ContainerStatus | undefined {
	return (pod.status?.containerStatuses ?? []).find((cs) => cs.name === AGENT_CONTAINER_NAME);
}

/** Every container status on the pod — init containers first, then the agent. */
function allContainerStatuses(pod: V1Pod): V1ContainerStatus[] {
	return [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
}

/**
 * Best-effort heartbeat anchor: the most recent meaningful timestamp on the pod
 * (agent container state transition, else pod `startTime`). ISO-8601 string or
 * `null`. NOT the warren event cursor (step 17 owns that) — purely a "last we
 * heard something" signal for the domain's watchdog.
 */
function heartbeatAnchor(pod: V1Pod): string | null {
	const candidates: Array<Date | undefined> = [];
	const agent = agentContainerStatus(pod);
	if (agent !== undefined) {
		candidates.push(agent.state?.terminated?.finishedAt);
		candidates.push(agent.state?.running?.startedAt);
	}
	candidates.push(pod.status?.startTime);
	let latest: Date | undefined;
	for (const c of candidates) {
		if (c === undefined) continue;
		const d = c instanceof Date ? c : new Date(c);
		if (Number.isNaN(d.getTime())) continue;
		if (latest === undefined || d.getTime() > latest.getTime()) latest = d;
	}
	return latest?.toISOString() ?? null;
}

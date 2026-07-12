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
 * | Failed           | a container terminated exit≠0 (Init:Error)  | failed    | error          | that code     |
 * | Failed           | evicted / no container status               | failed    | error          | null          |
 * | Unknown          | kubelet lost contact — NOT terminal         | running   | (none)         | null          |
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
 */

import type { V1ContainerStatus, V1Pod } from "@kubernetes/client-node";
import type { RunPhase, RunStatus, TerminalReason } from "../contract.ts";
import { AGENT_CONTAINER_NAME } from "./pod-spec.ts";

/** kubelet's `terminated.reason` for a cgroup OOM kill. */
const OOM_KILLED_REASON = "OOMKilled";

/**
 * The reconcile snapshot for a run whose pod is ABSENT from the API — deleted,
 * GC'd, or evicted-and-gone (design doc §1.3 / contract §6.7). Reported as a
 * terminal `failed` so the domain stops waiting, tagged `lost` so it knows the
 * run vanished rather than failing on its own merits, `exists:false` so the
 * caller can branch on run-lost. Mirrors LocalProvider's burrow-404 mapping.
 */
export function runLostStatus(): RunStatus {
	return {
		phase: "failed",
		exitCode: null,
		terminalReason: "lost",
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
	return {
		phase: classified.phase,
		exitCode: classified.exitCode,
		...(classified.terminalReason !== undefined
			? { terminalReason: classified.terminalReason }
			: {}),
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
 * Split a `Failed` pod on its container terminated states: an OOM kill anywhere
 * (agent OR init) is first-class `oom_killed`; any other non-zero termination is
 * `error` carrying its exit code; a pod that failed with no terminated container
 * status (evicted, node pressure) is `error` with a null exit code.
 */
function classifyFailed(pod: V1Pod): Classified {
	const terminated = allContainerStatuses(pod)
		.map((cs) => cs.state?.terminated ?? cs.lastState?.terminated)
		.filter((t): t is NonNullable<typeof t> => t !== undefined && t !== null);

	const oom = terminated.find((t) => t.reason === OOM_KILLED_REASON);
	if (oom !== undefined) {
		return { phase: "failed", exitCode: oom.exitCode ?? null, terminalReason: "oom_killed" };
	}
	const nonZero = terminated.find((t) => t.exitCode !== 0);
	if (nonZero !== undefined) {
		return { phase: "failed", exitCode: nonZero.exitCode ?? null, terminalReason: "error" };
	}
	// Failed phase but no failing terminated container (evicted / lost node).
	return { phase: "failed", exitCode: null, terminalReason: "error" };
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

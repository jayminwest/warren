import { describe, expect, test } from "bun:test";
import type { V1ContainerStatus, V1Pod } from "@kubernetes/client-node";
import { AGENT_CONTAINER_NAME, INIT_CONTAINER_NAME } from "./pod-spec.ts";
import { agentContainerStatus, mapPodToRunStatus, runLostStatus } from "./status-map.ts";

/** Build a pod with the given phase + container statuses. */
function pod(opts: {
	phase?: string;
	reason?: string;
	message?: string;
	containers?: V1ContainerStatus[];
	initContainers?: V1ContainerStatus[];
	startTime?: Date;
	labels?: Record<string, string>;
}): V1Pod {
	return {
		metadata: { name: "run-run-x", labels: opts.labels },
		status: {
			...(opts.phase !== undefined ? { phase: opts.phase } : {}),
			...(opts.reason !== undefined ? { reason: opts.reason } : {}),
			...(opts.message !== undefined ? { message: opts.message } : {}),
			...(opts.containers !== undefined ? { containerStatuses: opts.containers } : {}),
			...(opts.initContainers !== undefined ? { initContainerStatuses: opts.initContainers } : {}),
			...(opts.startTime !== undefined ? { startTime: opts.startTime } : {}),
		},
	};
}

function agentTerminated(exitCode: number, reason?: string, finishedAt?: Date): V1ContainerStatus {
	return {
		name: AGENT_CONTAINER_NAME,
		image: "warren-agent:latest",
		imageID: "",
		ready: false,
		restartCount: 0,
		state: {
			terminated: {
				exitCode,
				...(reason !== undefined ? { reason } : {}),
				...(finishedAt !== undefined ? { finishedAt } : {}),
			},
		},
	};
}

function agentRunning(startedAt: Date): V1ContainerStatus {
	return {
		name: AGENT_CONTAINER_NAME,
		image: "warren-agent:latest",
		imageID: "",
		ready: true,
		restartCount: 0,
		state: { running: { startedAt } },
	};
}

describe("runLostStatus", () => {
	test("is a terminal failed/lost snapshot with exists:false", () => {
		expect(runLostStatus()).toEqual({
			phase: "failed",
			exitCode: null,
			terminalReason: "lost",
			lastEventSeq: 0,
			lastEventTs: null,
			exists: false,
		});
	});
});

describe("mapPodToRunStatus — phase mapping", () => {
	test("absent phase (freshly created pod) → queued, non-terminal", () => {
		const s = mapPodToRunStatus(pod({}));
		expect(s.phase).toBe("queued");
		expect(s.terminalReason).toBeUndefined();
		expect(s.exitCode).toBeNull();
		expect(s.exists).toBe(true);
		expect(s.lastEventSeq).toBe(0);
	});

	test("Pending (scheduling / image pull) → queued", () => {
		const s = mapPodToRunStatus(pod({ phase: "Pending" }));
		expect(s.phase).toBe("queued");
		expect(s.terminalReason).toBeUndefined();
	});

	test("Pending with the workspace-init container running → still queued (agent not started)", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Pending",
				initContainers: [
					{
						name: INIT_CONTAINER_NAME,
						image: "warren-workspace-init:latest",
						imageID: "",
						ready: false,
						restartCount: 0,
						state: { running: { startedAt: new Date("2026-07-12T00:00:00Z") } },
					},
				],
			}),
		);
		expect(s.phase).toBe("queued");
		expect(s.terminalReason).toBeUndefined();
	});

	test("Running with the agent container running → running", () => {
		const s = mapPodToRunStatus(
			pod({ phase: "Running", containers: [agentRunning(new Date("2026-07-12T00:00:00Z"))] }),
		);
		expect(s.phase).toBe("running");
		expect(s.terminalReason).toBeUndefined();
		expect(s.exitCode).toBeNull();
	});

	test("Unknown (kubelet lost contact) → running, non-terminal (watchdog reclaims)", () => {
		const s = mapPodToRunStatus(pod({ phase: "Unknown" }));
		expect(s.phase).toBe("running");
		expect(s.terminalReason).toBeUndefined();
	});
});

describe("mapPodToRunStatus — Succeeded", () => {
	test("Succeeded with agent exit 0 → succeeded/completed, exitCode 0", () => {
		const s = mapPodToRunStatus(pod({ phase: "Succeeded", containers: [agentTerminated(0)] }));
		expect(s.phase).toBe("succeeded");
		expect(s.terminalReason).toBe("completed");
		expect(s.exitCode).toBe(0);
	});

	test("Succeeded with no container status still reports completed exit 0", () => {
		const s = mapPodToRunStatus(pod({ phase: "Succeeded" }));
		expect(s.phase).toBe("succeeded");
		expect(s.terminalReason).toBe("completed");
		expect(s.exitCode).toBe(0);
	});
});

describe("mapPodToRunStatus — Failed", () => {
	test("agent OOMKilled → failed/oom_killed, exitCode from the kill (fast-fail)", () => {
		const s = mapPodToRunStatus(
			pod({ phase: "Failed", containers: [agentTerminated(137, "OOMKilled")] }),
		);
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("oom_killed");
		expect(s.exitCode).toBe(137);
	});

	test("init container OOMKilled → oom_killed even though the agent never ran", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				initContainers: [
					{
						name: INIT_CONTAINER_NAME,
						image: "warren-workspace-init:latest",
						imageID: "",
						ready: false,
						restartCount: 0,
						state: { terminated: { exitCode: 137, reason: "OOMKilled" } },
					},
				],
			}),
		);
		expect(s.terminalReason).toBe("oom_killed");
		expect(s.exitCode).toBe(137);
	});

	test("agent non-zero exit → failed/error with that exit code", () => {
		const s = mapPodToRunStatus(
			pod({ phase: "Failed", containers: [agentTerminated(1, "Error")] }),
		);
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("error");
		expect(s.exitCode).toBe(1);
	});

	test("init container failure (Init:Error) → failed/error with the init exit code", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				initContainers: [
					{
						name: INIT_CONTAINER_NAME,
						image: "warren-workspace-init:latest",
						imageID: "",
						ready: false,
						restartCount: 0,
						state: { terminated: { exitCode: 128, reason: "Error" } },
					},
				],
			}),
		);
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("error");
		expect(s.exitCode).toBe(128);
	});

	test("Failed with no terminated container status → failed/error, exitCode null", () => {
		const s = mapPodToRunStatus(pod({ phase: "Failed" }));
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("error");
		expect(s.exitCode).toBeNull();
	});

	// warren-c0cd: the exact GKE Autopilot ephemeral-storage eviction footprint.
	test("ephemeral-storage eviction (reason Evicted + ContainerStatusUnknown 137) → failed/evicted", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				reason: "Evicted",
				message: "Pod ephemeral local storage usage exceeds the total limit of containers 1Gi.",
				containers: [
					agentTerminated(
						137,
						"ContainerStatusUnknown",
						// no finishedAt
					),
				],
			}),
		);
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("evicted");
		expect(s.exitCode).toBe(137);
		expect(s.exists).toBe(true);
	});

	test("eviction with no container status at all → failed/evicted, exitCode null", () => {
		const s = mapPodToRunStatus(pod({ phase: "Failed", reason: "Evicted" }));
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("evicted");
		expect(s.exitCode).toBeNull();
	});

	test("OOMKilled takes priority over an Evicted pod reason", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				reason: "Evicted",
				containers: [agentTerminated(137, "OOMKilled")],
			}),
		);
		expect(s.terminalReason).toBe("oom_killed");
		expect(s.exitCode).toBe(137);
	});

	test("ContainerStatusUnknown 137 WITHOUT an Evicted pod reason → failed/error (generic crash)", () => {
		const s = mapPodToRunStatus(
			pod({ phase: "Failed", containers: [agentTerminated(137, "ContainerStatusUnknown")] }),
		);
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("error");
		expect(s.exitCode).toBe(137);
	});

	test("OOM takes priority over a co-terminated non-zero init container", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				initContainers: [
					{
						name: INIT_CONTAINER_NAME,
						image: "i",
						imageID: "",
						ready: false,
						restartCount: 0,
						state: { terminated: { exitCode: 1, reason: "Error" } },
					},
				],
				containers: [agentTerminated(137, "OOMKilled")],
			}),
		);
		expect(s.terminalReason).toBe("oom_killed");
		expect(s.exitCode).toBe(137);
	});

	test("reads OOM off lastState.terminated when state has moved on", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				containers: [
					{
						name: AGENT_CONTAINER_NAME,
						image: "warren-agent:latest",
						imageID: "",
						ready: false,
						restartCount: 0,
						lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } },
					},
				],
			}),
		);
		expect(s.terminalReason).toBe("oom_killed");
		expect(s.exitCode).toBe(137);
	});
});

describe("mapPodToRunStatus — heartbeat anchor", () => {
	test("uses the agent terminated finishedAt when present", () => {
		const finishedAt = new Date("2026-07-12T01:02:03.000Z");
		const s = mapPodToRunStatus(
			pod({ phase: "Succeeded", containers: [agentTerminated(0, undefined, finishedAt)] }),
		);
		expect(s.lastEventTs).toBe("2026-07-12T01:02:03.000Z");
	});

	test("falls back to the pod startTime", () => {
		const s = mapPodToRunStatus(
			pod({ phase: "Running", startTime: new Date("2026-07-12T00:00:00.000Z") }),
		);
		expect(s.lastEventTs).toBe("2026-07-12T00:00:00.000Z");
	});

	test("null when the pod carries no usable timestamp", () => {
		expect(mapPodToRunStatus(pod({ phase: "Pending" })).lastEventTs).toBeNull();
	});
});

describe("agentContainerStatus", () => {
	test("finds the agent container by its well-known name", () => {
		const cs = agentTerminated(0);
		expect(agentContainerStatus(pod({ containers: [cs] }))?.name).toBe(AGENT_CONTAINER_NAME);
	});

	test("undefined when no agent container status is present", () => {
		expect(agentContainerStatus(pod({ phase: "Pending" }))).toBeUndefined();
	});
});

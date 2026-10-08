/**
 * Node-loss classification (warren-a757). The 2026-09-03 / 09-15 Spot
 * reclamations killed run pods with the agent container terminated `Error`
 * exit 137 — a SIGKILL from the dying node, not a cgroup OOM — and the run
 * was blamed on the model. These fixtures pin the split:
 *
 *   - `terminated.reason == "OOMKilled"` is the ONLY `oom_killed` witness;
 *   - `Error` 137 on a node the watcher saw go NotReady / vanish is `preempted`;
 *   - a `DisruptionTarget` condition the control plane stamps when it removes a
 *     pod from a lost node (taint manager, PodGC) is `preempted`;
 *   - a plain `Error` exit on a healthy node stays `error`.
 */

import { describe, expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import { AGENT_CONTAINER_NAME } from "./pod-spec.ts";
import { isPreemptedPod, mapPodToRunStatus } from "./status-map.ts";

interface Fixture {
	phase?: string;
	terminated?: { reason: string; exitCode: number };
	conditions?: Array<{ type: string; status: string; reason?: string }>;
	podReason?: string;
}

function pod(f: Fixture): V1Pod {
	return {
		metadata: { name: "run-run-x" },
		spec: { nodeName: "gk3-warren-nap-spot-8tdj", containers: [] },
		status: {
			phase: f.phase ?? "Failed",
			...(f.podReason !== undefined ? { reason: f.podReason } : {}),
			...(f.conditions !== undefined ? { conditions: f.conditions } : {}),
			containerStatuses:
				f.terminated !== undefined
					? [
							{
								name: AGENT_CONTAINER_NAME,
								image: "warren-agent",
								imageID: "",
								ready: false,
								restartCount: 0,
								state: { terminated: f.terminated },
							},
						]
					: [],
		},
	} as unknown as V1Pod;
}

const OOM = { reason: "OOMKilled", exitCode: 137 };
const SIGKILL = { reason: "Error", exitCode: 137 };
const CRASH = { reason: "Error", exitCode: 1 };

describe("mapPodToRunStatus — node loss vs OOM (warren-a757)", () => {
	test("OOMKilled → oom_killed", () => {
		const s = mapPodToRunStatus(pod({ terminated: OOM }));
		expect(s.terminalReason).toBe("oom_killed");
		expect(s.exitCode).toBe(137);
	});

	test("OOMKilled stays oom_killed even when the node was also lost", () => {
		const s = mapPodToRunStatus(pod({ terminated: OOM }), { nodeLost: true });
		expect(s.terminalReason).toBe("oom_killed");
	});

	test("Error 137 with no node-loss witness is a plain error, NOT oom_killed", () => {
		const s = mapPodToRunStatus(pod({ terminated: SIGKILL }));
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("error");
		expect(s.exitCode).toBe(137);
	});

	test("Error 137 with the node gone (nodeLost hint) → preempted, exit 137 carried", () => {
		const s = mapPodToRunStatus(pod({ terminated: SIGKILL }), { nodeLost: true });
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("preempted");
		expect(s.exitCode).toBe(137);
		expect(s.nodeLost).toBe(true);
	});

	for (const reason of [
		"TerminationByKubelet",
		"DeletionByTaintManager",
		"DeletionByPodGC",
		"PreemptionByScheduler",
		"EvictionByEvictionAPI",
	]) {
		test(`DisruptionTarget=True/${reason} on Error 137 → preempted`, () => {
			const p = pod({
				terminated: SIGKILL,
				conditions: [{ type: "DisruptionTarget", status: "True", reason }],
			});
			expect(isPreemptedPod(p)).toBe(true);
			expect(mapPodToRunStatus(p).terminalReason).toBe("preempted");
		});
	}

	test("a DisruptionTarget=False condition is not a witness", () => {
		const p = pod({
			terminated: SIGKILL,
			conditions: [{ type: "DisruptionTarget", status: "False", reason: "DeletionByPodGC" }],
		});
		expect(isPreemptedPod(p)).toBe(false);
		expect(mapPodToRunStatus(p).terminalReason).toBe("error");
	});

	test("a kubelet pressure eviction (TerminationByKubelet + Evicted) stays evicted", () => {
		const p = pod({
			podReason: "Evicted",
			terminated: { reason: "ContainerStatusUnknown", exitCode: 137 },
			conditions: [{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" }],
		});
		expect(mapPodToRunStatus(p).terminalReason).toBe("evicted");
	});

	test("plain Error exit 1 on a healthy node → error", () => {
		const s = mapPodToRunStatus(pod({ terminated: CRASH }));
		expect(s.terminalReason).toBe("error");
		expect(s.exitCode).toBe(1);
		expect(s.nodeLost).toBeUndefined();
	});

	test("a Running pod on a lost node stays running but carries the nodeLost witness", () => {
		const s = mapPodToRunStatus(pod({ phase: "Running" }), { nodeLost: true });
		expect(s.phase).toBe("running");
		expect(s.terminalReason).toBeUndefined();
		expect(s.nodeLost).toBe(true);
	});
});

/**
 * Spot-preemption classification tests (warren-ea4b). A GKE Spot node being
 * reclaimed under a run pod must classify `failed` with the new retryable
 * `preempted` terminalReason, not an anonymous `error`. Three witnesses:
 *
 *   - `status.reason` `Terminated`/`Shutdown` + the kubelet node-shutdown message;
 *   - a `DisruptionTarget` condition with reason `TerminationByKubelet`;
 *   - (cluster-side) the pod vanishing while its spot node was deleted —
 *     covered by the pod-watcher + provider tests, not this pure map.
 */

import { describe, expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import { mapPodToRunStatus, runLostStatus } from "./status-map.ts";

function pod(opts: {
	phase?: string;
	reason?: string;
	message?: string;
	conditions?: Array<{ type: string; status?: string; reason?: string }>;
}): V1Pod {
	return {
		metadata: { name: "run-run-x" },
		status: {
			...(opts.phase !== undefined ? { phase: opts.phase } : {}),
			...(opts.reason !== undefined ? { reason: opts.reason } : {}),
			...(opts.message !== undefined ? { message: opts.message } : {}),
			...(opts.conditions !== undefined
				? { conditions: opts.conditions.map((c) => ({ status: "True", ...c })) }
				: {}),
		},
	};
}

describe("mapPodToRunStatus — Spot preemption (warren-ea4b)", () => {
	test("reason Shutdown with the node-shutdown message → failed/preempted", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				reason: "Shutdown",
				message: "The node is shutting down",
			}),
		);
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("preempted");
	});

	test("reason Terminated with the node-shutdown message → failed/preempted, exit 137 carried", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				reason: "Terminated",
				message: "The node was shut down by the cloud provider",
			}),
		);
		expect(s.terminalReason).toBe("preempted");
	});

	test("reason Shutdown without a node-shutdown message is NOT a preemption", () => {
		const s = mapPodToRunStatus(pod({ phase: "Failed", reason: "Shutdown", message: "???" }));
		expect(s.terminalReason).toBe("error");
	});

	test("DisruptionTarget condition with TerminationByKubelet → failed/preempted", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				conditions: [{ type: "DisruptionTarget", reason: "TerminationByKubelet" }],
			}),
		);
		expect(s.phase).toBe("failed");
		expect(s.terminalReason).toBe("preempted");
	});

	test("a DisruptionTarget condition with another reason is not a preemption", () => {
		const s = mapPodToRunStatus(
			pod({
				phase: "Failed",
				conditions: [{ type: "DisruptionTarget", reason: "EvictionByTaintManager" }],
			}),
		);
		expect(s.terminalReason).toBe("error");
	});

	test("a non-shutdown message on a Terminated pod stays a plain error", () => {
		const s = mapPodToRunStatus(
			pod({ phase: "Failed", reason: "Terminated", message: "agent exited" }),
		);
		expect(s.terminalReason).toBe("error");
	});
});

describe("runLostStatus — preemption variant (warren-ea4b)", () => {
	test("defaults to lost; accepts preempted for the vanished-spot-pod witness", () => {
		expect(runLostStatus().terminalReason).toBe("lost");
		expect(runLostStatus("preempted").terminalReason).toBe("preempted");
		expect(runLostStatus("preempted").exists).toBe(false);
		expect(runLostStatus("preempted").phase).toBe("failed");
	});
});

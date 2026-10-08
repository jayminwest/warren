/**
 * Node-loss witness tests (warren-a757). A GKE Spot reclamation shows up as
 * a `NodeNotReady` pod warning, then a taint-manager / PodGC deletion whose
 * final object carries a `DisruptionTarget` condition. The watcher must keep
 * those witnesses after the pod is gone so `K8sProvider.status()` reads the
 * run as `preempted` (infra-lost, retryable) instead of plain `lost`/`error`.
 * Fakes are shared from `pod-watcher.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import { METRIC_PREEMPTED_TOTAL } from "./pod-metrics.ts";
import { AGENT_CONTAINER_NAME, LABEL_RUN_ID } from "./pod-spec.ts";
import { FakeCounters, FakeWatch, listReturning, waitForConnections } from "./pod-watcher.test.ts";
import { NODE_NOT_READY_EVENT_REASON, PodWatcher, withNodeLossWitness } from "./pod-watcher.ts";

/** A run pod fixture on a spot node, with optional DisruptionTarget + agent exit. */
function runPod(
	runId: string,
	opts: { phase: string; disruption?: string; agentExit?: { reason: string; exitCode: number } },
): V1Pod {
	return {
		metadata: { name: `run-${runId}`, labels: { [LABEL_RUN_ID]: runId } },
		spec: { nodeName: "gk3-warren-nap-spot-8tdj", containers: [] },
		status: {
			phase: opts.phase,
			...(opts.disruption !== undefined
				? { conditions: [{ type: "DisruptionTarget", status: "True", reason: opts.disruption }] }
				: {}),
			...(opts.agentExit !== undefined
				? {
						containerStatuses: [
							{ name: AGENT_CONTAINER_NAME, state: { terminated: opts.agentExit } },
						],
					}
				: {}),
		},
	} as unknown as V1Pod;
}

async function startedWatcher() {
	const watch = new FakeWatch();
	const counters = new FakeCounters();
	const watcher = new PodWatcher({
		list: listReturning([], "1").fn,
		watch: watch.watch,
		namespace: "warren-runs",
		metrics: counters,
		backoffBaseMs: 1,
		backoffMaxMs: 4,
		resyncPeriodMs: 0,
	});
	watcher.start();
	await waitForConnections(watch, 1);
	return { watcher, conn: watch.latest(), counters };
}

describe("pod-watcher — node-loss witnesses (warren-a757)", () => {
	test("the DELETED final object's DeletionByPodGC witness records the preemption", async () => {
		const { watcher, conn, counters } = await startedWatcher();
		conn.onEvent("ADDED", runPod("run_gc", { phase: "Running" }));
		conn.onEvent(
			"DELETED",
			runPod("run_gc", {
				phase: "Failed",
				disruption: "DeletionByPodGC",
				agentExit: { reason: "Error", exitCode: 137 },
			}),
		);
		expect(watcher.wasPreempted("run_gc")).toBe(true);
		expect(counters.get(METRIC_PREEMPTED_TOTAL)).toBe(1);
		await watcher.stop();
	});

	test("a taint-manager deletion still reading Running is a preemption once gone", async () => {
		const { watcher, conn } = await startedWatcher();
		conn.onEvent("ADDED", runPod("run_tm", { phase: "Running" }));
		conn.onEvent(
			"DELETED",
			runPod("run_tm", { phase: "Running", disruption: "DeletionByTaintManager" }),
		);
		expect(watcher.wasPreempted("run_tm")).toBe(true);
		await watcher.stop();
	});

	test("a status-witnessed preemption survives the pod's deletion", async () => {
		const { watcher, conn, counters } = await startedWatcher();
		const failed = runPod("run_sw", { phase: "Failed", disruption: "TerminationByKubelet" });
		conn.onEvent("ADDED", failed);
		expect(watcher.wasPreempted("run_sw")).toBe(false);
		conn.onEvent("DELETED", failed);
		expect(watcher.wasPreempted("run_sw")).toBe(true);
		expect(counters.get(METRIC_PREEMPTED_TOTAL)).toBe(1);
		await watcher.stop();
	});

	test("a warren delete of a plain Error pod is not a preemption", async () => {
		const { watcher, conn, counters } = await startedWatcher();
		const crashed = runPod("run_err", {
			phase: "Failed",
			agentExit: { reason: "Error", exitCode: 1 },
		});
		conn.onEvent("ADDED", crashed);
		conn.onEvent("DELETED", crashed);
		expect(watcher.wasPreempted("run_err")).toBe(false);
		expect(counters.get(METRIC_PREEMPTED_TOTAL)).toBe(0);
		await watcher.stop();
	});

	test("noteNodeLost marks the run and counts an Error 137 pod exactly once", async () => {
		const { watcher, conn, counters } = await startedWatcher();
		const killed = runPod("run_nn", {
			phase: "Failed",
			agentExit: { reason: "Error", exitCode: 137 },
		});
		conn.onEvent("ADDED", killed);
		expect(counters.get(METRIC_PREEMPTED_TOTAL)).toBe(0);
		watcher.noteNodeLost("run_nn");
		watcher.noteNodeLost("run_nn"); // idempotent
		conn.onEvent("MODIFIED", killed);
		expect(watcher.wasPreempted("run_nn")).toBe(true);
		expect(counters.get(METRIC_PREEMPTED_TOTAL)).toBe(1);
		await watcher.stop();
	});

	test("withNodeLossWitness notes NodeNotReady and forwards every signal", () => {
		const noted: string[] = [];
		const forwarded: string[] = [];
		const sink = withNodeLossWitness<{ runId: string; reason: string }>(
			{ noteNodeLost: (runId) => noted.push(runId) },
			(signal) => forwarded.push(signal.reason),
		);
		sink({ runId: "run_a", reason: NODE_NOT_READY_EVENT_REASON });
		sink({ runId: "run_b", reason: "FailedScheduling" });
		expect(noted).toEqual(["run_a"]);
		expect(forwarded).toEqual(["NodeNotReady", "FailedScheduling"]);
	});
});

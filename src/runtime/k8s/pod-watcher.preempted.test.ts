/**
 * Spot-preemption witness tests (warren-ea4b). Split out of
 * `pod-watcher.test.ts` for the file-size ratchet, mirroring
 * `pod-watcher.eviction.test.ts`; the fakes are shared from there.
 *
 * Two arms:
 *   - a pod whose own status witnesses the preemption increments
 *     `warren_run_preempted_total` exactly once;
 *   - a pod that VANISHES while its (spot-labelled) node was deleted is
 *     recorded by `deletedSpotNode`, counted once, and remembered so
 *     `K8sProvider.status()` can map the absent pod to `preempted`.
 */

import { describe, expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import { METRIC_PREEMPTED_TOTAL } from "./pod-metrics.ts";
import { LABEL_RUN_ID } from "./pod-spec.ts";
import { FakeCounters, FakeWatch, listReturning, waitForConnections } from "./pod-watcher.test.ts";
import { PodWatcher } from "./pod-watcher.ts";

function preemptedPod(runId: string): V1Pod {
	return {
		metadata: { name: `run-${runId}`, labels: { [LABEL_RUN_ID]: runId } },
		status: {
			phase: "Failed",
			reason: "Shutdown",
			message: "The node is shutting down",
		},
	};
}

describe("pod-watcher — spot preemption (warren-ea4b)", () => {
	test("a status-witnessed preempted pod increments the counter exactly once", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const counters = new FakeCounters();
		const warns: Array<{ obj: unknown; msg: string }> = [];
		const watcher = new PodWatcher({
			list: list.fn,
			watch: watch.watch,
			namespace: "warren-runs",
			metrics: counters,
			backoffBaseMs: 1,
			backoffMaxMs: 4,
			resyncPeriodMs: 0,
			logger: {
				warn: (obj, msg) => {
					warns.push({ obj, msg });
				},
			},
		});
		watcher.start();
		await waitForConnections(watch, 1);
		const conn = watch.latest();
		const pod = preemptedPod("run_pre");
		conn.onEvent("ADDED", pod);
		conn.onEvent("MODIFIED", pod); // duplicate — must not re-count
		expect(counters.get(METRIC_PREEMPTED_TOTAL)).toBe(1);
		expect(watcher.wasPreempted("run_pre")).toBe(false);
		await watcher.stop();
		expect(warns).toHaveLength(1);
		expect(warns[0]?.msg).toBe("run pod preempted (spot node reclaimed)");
	});

	test("a pod vanishing while its spot node was deleted records the preemption", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const counters = new FakeCounters();
		const watcher = new PodWatcher({
			list: list.fn,
			watch: watch.watch,
			namespace: "warren-runs",
			metrics: counters,
			backoffBaseMs: 1,
			backoffMaxMs: 4,
			resyncPeriodMs: 0,
			deletedSpotNode: (nodeName) => nodeName === "gk3-spot-pool-abc",
		});
		watcher.start();
		await waitForConnections(watch, 1);
		const conn = watch.latest();
		conn.onEvent("ADDED", {
			metadata: { name: "run-run_van", labels: { [LABEL_RUN_ID]: "run_van" } },
			spec: { nodeName: "gk3-spot-pool-abc", containers: [] },
			status: { phase: "Running" },
		} as unknown as V1Pod);
		conn.onEvent("DELETED", {
			metadata: { name: "run-run_van", labels: { [LABEL_RUN_ID]: "run_van" } },
			spec: { nodeName: "gk3-spot-pool-abc", containers: [] },
			status: { phase: "Running" },
		} as unknown as V1Pod);
		expect(watcher.wasPreempted("run_van")).toBe(true);
		expect(counters.get(METRIC_PREEMPTED_TOTAL)).toBe(1);
		await watcher.stop();
	});

	test("a pod vanishing on a NON-spot (or surviving) node is not a preemption", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const watcher = new PodWatcher({
			list: list.fn,
			watch: watch.watch,
			namespace: "warren-runs",
			metrics: new FakeCounters(),
			backoffBaseMs: 1,
			backoffMaxMs: 4,
			resyncPeriodMs: 0,
			deletedSpotNode: (nodeName) => nodeName === "gk3-spot-pool-abc",
		});
		watcher.start();
		await waitForConnections(watch, 1);
		const conn = watch.latest();
		conn.onEvent("ADDED", {
			metadata: { name: "run-run_keep", labels: { [LABEL_RUN_ID]: "run_keep" } },
			spec: { nodeName: "gk3-main-pool-def", containers: [] },
			status: { phase: "Running" },
		} as unknown as V1Pod);
		conn.onEvent("DELETED", {
			metadata: { name: "run-run_keep", labels: { [LABEL_RUN_ID]: "run_keep" } },
			spec: { nodeName: "gk3-main-pool-def", containers: [] },
			status: { phase: "Running" },
		} as unknown as V1Pod);
		expect(watcher.wasPreempted("run_keep")).toBe(false);
		await watcher.stop();
	});
});

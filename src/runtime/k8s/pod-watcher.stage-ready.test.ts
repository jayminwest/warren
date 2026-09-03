import { describe, expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import { METRIC_INIT_FAILURES_TOTAL } from "./pod-metrics.ts";
import { INIT_CONTAINER_NAME, LABEL_RUN_ID } from "./pod-spec.ts";
import { FakeCounters, FakeWatch, listReturning, waitForConnections } from "./pod-watcher.test.ts";
import { PodWatcher } from "./pod-watcher.ts";

// --- Workspace-ready signal (warren-7116) ------------------------------------

describe("PodWatcher — workspace-ready signal (warren-7116)", () => {
	function initPod(runId: string, exitCode = 0): V1Pod {
		return {
			metadata: { name: `run-${runId}`, labels: { [LABEL_RUN_ID]: runId } },
			status: {
				phase: "Running",
				initContainerStatuses: [
					{
						name: INIT_CONTAINER_NAME,
						image: "warren-workspace-init:latest",
						imageID: "",
						ready: true,
						restartCount: 0,
						state: {
							terminated: {
								exitCode,
								startedAt: new Date("2026-07-12T00:00:00Z"),
								finishedAt: new Date("2026-07-12T00:00:04Z"),
							},
						},
					},
				],
			},
		};
	}

	test("a terminated workspace-init container fires the onWorkspaceReady signal off the kubelet stamp", async () => {
		const signals: Array<{ runId: string; at: Date }> = [];
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
			onWorkspaceReady: (runId, at) => void signals.push({ runId, at }),
		});
		watcher.start();
		await waitForConnections(watch, 1);

		watch.latest().onEvent("ADDED", initPod("run_ready"));
		expect(signals).toEqual([{ runId: "run_ready", at: new Date("2026-07-12T00:00:04Z") }]);

		// A resync replaying the same pod must NOT re-fire — the watcher
		// accounts the init container once per run and the domain writer is
		// first-write-wins anyway.
		watch.latest().onEvent("MODIFIED", initPod("run_ready"));
		expect(signals).toHaveLength(1);
		await watcher.stop();
	});

	test("the signal fires even when the init container failed, and a watcher without the sink stays inert", async () => {
		const signals: Array<{ runId: string; at: Date }> = [];
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const metrics = new FakeCounters();
		const watcher = new PodWatcher({
			list: list.fn,
			watch: watch.watch,
			namespace: "warren-runs",
			metrics,
			backoffBaseMs: 1,
			backoffMaxMs: 4,
			resyncPeriodMs: 0,
			onWorkspaceReady: (runId, at) => void signals.push({ runId, at }),
		});
		watcher.start();
		await waitForConnections(watch, 1);

		// exitCode 1: still a workspace-ready observation (init DONE, badly).
		watch.latest().onEvent("ADDED", initPod("run_failed", 1));
		expect(signals).toEqual([{ runId: "run_failed", at: new Date("2026-07-12T00:00:04Z") }]);
		expect(metrics.get(METRIC_INIT_FAILURES_TOTAL)).toBe(1);
		await watcher.stop();

		// No onWorkspaceReady wired → the init accounting must not throw.
		const plain = new PodWatcher({
			list: list.fn,
			watch: new FakeWatch().watch,
			namespace: "warren-runs",
			metrics: new FakeCounters(),
			backoffBaseMs: 1,
			backoffMaxMs: 4,
			resyncPeriodMs: 0,
		});
		plain.start();
		await plain.stop();
	});
});

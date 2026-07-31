/**
 * Eviction-cause capture tests (warren-4a95). The evicted pod — and its
 * kubectl events — age out of the K8s API within the hour, so the kubelet's
 * `status.message` (e.g. `Pod ephemeral local storage usage exceeds the total
 * limit of containers 10Gi`) must land in warren's own telemetry the moment
 * the watcher observes it. Split out of `pod-watcher.test.ts` for the
 * file-size ratchet; the fakes are shared from there.
 */

import { describe, expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import { LABEL_RUN_ID } from "./pod-spec.ts";
import { FakeCounters, FakeWatch, listReturning, waitForConnections } from "./pod-watcher.test.ts";
import { PodWatcher } from "./pod-watcher.ts";

describe("pod-watcher — eviction cause capture (warren-4a95)", () => {
	test("an evicted pod warn-logs the kubelet detail exactly once", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const warns: Array<{ obj: unknown; msg: string }> = [];
		const watcher = new PodWatcher({
			list: list.fn,
			watch: watch.watch,
			namespace: "warren-runs",
			metrics: new FakeCounters(),
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
		const message = "Pod ephemeral local storage usage exceeds the total limit of containers 10Gi.";
		const evictedPod: V1Pod = {
			metadata: { name: "run-run_evicted", labels: { [LABEL_RUN_ID]: "run_evicted" } },
			status: { phase: "Failed", reason: "Evicted", message },
		};
		conn.onEvent("ADDED", evictedPod);
		conn.onEvent("MODIFIED", evictedPod); // duplicate — must not re-log
		expect(warns).toHaveLength(1);
		expect(warns[0]?.msg).toBe("run pod evicted by kubelet");
		expect(warns[0]?.obj).toMatchObject({
			runId: "run_evicted",
			reason: "Evicted",
			detail: message,
		});
		await watcher.stop();
	});
});

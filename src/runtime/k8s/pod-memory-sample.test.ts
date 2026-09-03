import { describe, expect, test } from "bun:test";
import type { PodMetric } from "@kubernetes/client-node";
import {
	containerMemoryMiB,
	parseMemoryMiB,
	sampleRunPodMemoryMiB,
	toPodMemorySample,
} from "./pod-memory-sample.ts";

function podMetric(name: string, containers: { name: string; memory: string }[]): PodMetric {
	return {
		metadata: {
			name,
			namespace: "warren-runs",
			selfLink: "",
			creationTimestamp: new Date().toISOString(),
		},
		timestamp: new Date().toISOString(),
		window: "1m0s",
		containers: containers.map((c) => ({ name: c.name, usage: { cpu: "10m", memory: c.memory } })),
	};
}

describe("pod-memory-sample", () => {
	test("parses common k8s memory quantities into MiB", () => {
		expect(parseMemoryMiB("1129Mi")).toBeCloseTo(1129);
		expect(parseMemoryMiB("512Ki")).toBeCloseTo(0.5);
		expect(parseMemoryMiB("2Gi")).toBeCloseTo(2048);
		expect(parseMemoryMiB("1234567")).toBeCloseTo(1234567 / (1024 * 1024));
	});

	test("returns undefined for unparseable quantities", () => {
		expect(parseMemoryMiB("")).toBeUndefined();
		expect(parseMemoryMiB("abc")).toBeUndefined();
		expect(parseMemoryMiB("12XB")).toBeUndefined();
	});

	test("extracts named container memory", () => {
		const pod = podMetric("run-abc", [
			{ name: "workspace-init", memory: "59Mi" },
			{ name: "agent", memory: "1623Mi" },
		]);
		expect(containerMemoryMiB(pod, "agent")).toBeCloseTo(1623);
		expect(containerMemoryMiB(pod, "workspace-init")).toBeCloseTo(59);
		expect(containerMemoryMiB(pod, "nope")).toBeUndefined();
	});

	test("shapes a sample; init field omitted when absent", () => {
		const withInit = podMetric("run-abc", [
			{ name: "agent", memory: "1129Mi" },
			{ name: "workspace-init", memory: "390Mi" },
		]);
		const s = toPodMemorySample("run_abc", "run-abc", withInit);
		expect(s?.agentMemoryMiB).toBeCloseTo(1129);
		expect(s?.workspaceInitMemoryMiB).toBeCloseTo(390);
		expect(s?.runId).toBe("run_abc");

		const noInit = podMetric("run-abc", [{ name: "agent", memory: "1129Mi" }]);
		const s2 = toPodMemorySample("run_abc", "run-abc", noInit);
		expect(s2?.workspaceInitMemoryMiB).toBeUndefined();

		const noAgent = podMetric("run-abc", [{ name: "sidecar", memory: "10Mi" }]);
		expect(toPodMemorySample("run_abc", "run-abc", noAgent)).toBeUndefined();
	});

	test("sampleRunPodMemoryMiB finds the pod and returns a sample", async () => {
		const pod = podMetric("run-abc-123", [{ name: "agent", memory: "1494Mi" }]);
		const sample = await sampleRunPodMemoryMiB("run_abc_123", {
			podName: "run-abc-123",
			fetchPodMetrics: async () => [pod],
		});
		expect(sample?.agentMemoryMiB).toBeCloseTo(1494);
		expect(sample?.podName).toBe("run-abc-123");
	});

	test("sampleRunPodMemoryMiB resolves undefined when the pod is missing", async () => {
		const sample = await sampleRunPodMemoryMiB("run_gone", {
			fetchPodMetrics: async () => [podMetric("run-other", [{ name: "agent", memory: "10Mi" }])],
		});
		expect(sample).toBeUndefined();
	});

	test("sampleRunPodMemoryMiB never throws — fetch failure degrades to undefined", async () => {
		const sample = await sampleRunPodMemoryMiB("run_x", {
			fetchPodMetrics: async () => {
				throw new Error("no cluster");
			},
		});
		expect(sample).toBeUndefined();
	});

	test("sampleRunPodMemoryMiB times out instead of hanging", async () => {
		const sample = await sampleRunPodMemoryMiB("run_slow", {
			timeoutMs: 20,
			fetchPodMetrics: () => new Promise<never>(() => {}),
		});
		expect(sample).toBeUndefined();
	});
});

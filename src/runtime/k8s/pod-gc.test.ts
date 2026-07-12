import { describe, expect, test } from "bun:test";
import type { V1ConfigMap, V1Pod } from "@kubernetes/client-node";
import { DEFAULT_GC_MAX_AGE_MS, PodGc, type PodGcDeps, sweepPodGc } from "./pod-gc.ts";
import { METRIC_POD_GC_DELETIONS_TOTAL } from "./pod-metrics.ts";
import { LABEL_RUN_ID } from "./pod-spec.ts";
import type { CounterSink } from "./pod-watcher.ts";

const NOW_MS = Date.UTC(2026, 6, 12, 12, 0, 0);
const now = (): Date => new Date(NOW_MS);

/** A run pod with a terminal phase + a `finishedAt` `minutesAgo` in the past. */
function terminalPod(runId: string, phase: "Succeeded" | "Failed", minutesAgo: number): V1Pod {
	const finishedAt = new Date(NOW_MS - minutesAgo * 60_000);
	return {
		metadata: { name: `run-${runId}`, labels: { [LABEL_RUN_ID]: runId } },
		status: {
			phase,
			containerStatuses: [
				{
					name: "agent",
					image: "warren-agent:latest",
					imageID: "",
					ready: false,
					restartCount: 0,
					state: { terminated: { exitCode: phase === "Failed" ? 1 : 0, finishedAt } },
				},
			],
		},
	};
}

function runningPod(runId: string): V1Pod {
	return {
		metadata: { name: `run-${runId}`, labels: { [LABEL_RUN_ID]: runId } },
		status: { phase: "Running" },
	};
}

function seedCm(runId: string): V1ConfigMap {
	return { metadata: { name: `run-${runId}-seeds`, labels: { [LABEL_RUN_ID]: runId } } };
}

class FakeCounters implements CounterSink {
	readonly calls: Array<{ name: string; labels: Record<string, string> }> = [];
	increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
		this.calls.push({ name, labels: { ...labels } });
	}
	count(resource: string): number {
		return this.calls.filter(
			(c) => c.name === METRIC_POD_GC_DELETIONS_TOTAL && c.labels.resource === resource,
		).length;
	}
}

function makeDeps(
	pods: V1Pod[],
	configMaps: V1ConfigMap[],
	overrides: Partial<PodGcDeps> = {},
): {
	deps: PodGcDeps;
	deletedPods: string[];
	deletedCms: string[];
	metrics: FakeCounters;
} {
	const deletedPods: string[] = [];
	const deletedCms: string[] = [];
	const metrics = new FakeCounters();
	const deps: PodGcDeps = {
		listPods: () => Promise.resolve(pods),
		listConfigMaps: () => Promise.resolve(configMaps),
		deletePod: (name) => {
			deletedPods.push(name);
			return Promise.resolve();
		},
		deleteConfigMap: (name) => {
			deletedCms.push(name);
			return Promise.resolve();
		},
		metrics,
		now,
		...overrides,
	};
	return { deps, deletedPods, deletedCms, metrics };
}

describe("sweepPodGc — pod age partition", () => {
	test("deletes a terminal pod older than the 30-min window", async () => {
		const { deps, deletedPods } = makeDeps([terminalPod("old", "Failed", 40)], []);
		const result = await sweepPodGc(deps);
		expect(deletedPods).toEqual(["run-old"]);
		expect(result.podsDeleted).toBe(1);
	});

	test("keeps a terminal pod younger than the window", async () => {
		const { deps, deletedPods } = makeDeps([terminalPod("young", "Succeeded", 5)], []);
		const result = await sweepPodGc(deps);
		expect(deletedPods).toEqual([]);
		expect(result.podsDeleted).toBe(0);
	});

	test("keeps a Running pod regardless of age", async () => {
		const { deps, deletedPods } = makeDeps([runningPod("live")], []);
		await sweepPodGc(deps);
		expect(deletedPods).toEqual([]);
	});

	test("respects a custom maxAgeMs", async () => {
		const { deps, deletedPods } = makeDeps([terminalPod("t", "Failed", 10)], [], {
			maxAgeMs: 5 * 60_000,
		});
		await sweepPodGc(deps);
		expect(deletedPods).toEqual(["run-t"]);
	});

	test("un-ageable terminal pod (no finishedAt, no creationTimestamp) is kept", async () => {
		const pod: V1Pod = {
			metadata: { name: "run-noanchor", labels: { [LABEL_RUN_ID]: "noanchor" } },
			status: { phase: "Failed" },
		};
		const { deps, deletedPods } = makeDeps([pod], []);
		await sweepPodGc(deps);
		expect(deletedPods).toEqual([]);
	});

	test("falls back to creationTimestamp when no container finishedAt", async () => {
		const pod: V1Pod = {
			metadata: {
				name: "run-created",
				labels: { [LABEL_RUN_ID]: "created" },
				creationTimestamp: new Date(NOW_MS - 45 * 60_000),
			},
			status: { phase: "Failed" },
		};
		const { deps, deletedPods } = makeDeps([pod], []);
		await sweepPodGc(deps);
		expect(deletedPods).toEqual(["run-created"]);
	});
});

describe("sweepPodGc — ConfigMap reclamation", () => {
	test("reclaims the ConfigMap of a just-deleted old pod", async () => {
		const { deps, deletedCms } = makeDeps([terminalPod("old", "Failed", 40)], [seedCm("old")]);
		const result = await sweepPodGc(deps);
		expect(deletedCms).toEqual(["run-old-seeds"]);
		expect(result.configMapsDeleted).toBe(1);
	});

	test("reclaims an orphaned ConfigMap whose pod no longer exists", async () => {
		const { deps, deletedCms } = makeDeps([], [seedCm("orphan")]);
		await sweepPodGc(deps);
		expect(deletedCms).toEqual(["run-orphan-seeds"]);
	});

	test("spares the ConfigMap of a live pod", async () => {
		const { deps, deletedCms } = makeDeps([runningPod("live")], [seedCm("live")]);
		await sweepPodGc(deps);
		expect(deletedCms).toEqual([]);
	});

	test("spares the ConfigMap of a terminal-but-young pod", async () => {
		const { deps, deletedCms } = makeDeps(
			[terminalPod("young", "Succeeded", 5)],
			[seedCm("young")],
		);
		await sweepPodGc(deps);
		expect(deletedCms).toEqual([]);
	});
});

describe("sweepPodGc — metrics + failure isolation", () => {
	test("increments the GC-deletions counter per resource kind", async () => {
		const { deps, metrics } = makeDeps(
			[terminalPod("old", "Failed", 40)],
			[seedCm("old"), seedCm("orphan")],
		);
		await sweepPodGc(deps);
		expect(metrics.count("pod")).toBe(1);
		expect(metrics.count("configmap")).toBe(2);
	});

	test("a delete failure is logged + skipped, not fatal to the sweep", async () => {
		const warnings: string[] = [];
		const { deps } = makeDeps(
			[terminalPod("a", "Failed", 40), terminalPod("b", "Failed", 40)],
			[],
			{
				deletePod: (name) =>
					name === "run-a" ? Promise.reject(new Error("boom")) : Promise.resolve(),
				logger: { warn: (_o, msg) => warnings.push(msg) },
			},
		);
		const result = await sweepPodGc(deps);
		// b still deleted despite a failing; the failure counts as not-deleted.
		expect(result.podsDeleted).toBe(1);
		expect(warnings).toContain("pod-gc pod delete failed");
	});
});

describe("PodGc lifecycle", () => {
	test("start() runs at least one sweep; stop() resolves", async () => {
		let swept = 0;
		let signalFirst: () => void = () => {};
		const first = new Promise<void>((r) => {
			signalFirst = r;
		});
		const { deps } = makeDeps([], [], {
			listPods: () => {
				swept++;
				signalFirst();
				return Promise.resolve([]);
			},
			intervalMs: 60_000, // long — only one sweep before stop
		});
		const gc = new PodGc(deps);
		gc.start();
		await first;
		await gc.stop();
		expect(swept).toBeGreaterThanOrEqual(1);
	});

	test("double start() is a no-op; double stop() is safe", async () => {
		const { deps } = makeDeps([], [], { intervalMs: 60_000 });
		const gc = new PodGc(deps);
		gc.start();
		gc.start(); // no-op
		await gc.stop();
		await gc.stop(); // idempotent
		expect(true).toBe(true);
	});

	test("stop() unparks the inter-sweep sleep promptly", async () => {
		const { deps } = makeDeps([], [], { intervalMs: 10 * 60_000 });
		const gc = new PodGc(deps);
		gc.start();
		const startedAt = Date.now();
		await gc.stop();
		// Would hang ~10 min if the sleep were not abortable.
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	test("default retention window is 30 minutes", () => {
		expect(DEFAULT_GC_MAX_AGE_MS).toBe(30 * 60 * 1000);
	});
});

import { describe, expect, test } from "bun:test";
import type { CoreV1Api } from "@kubernetes/client-node";
import { MetricsRegistry } from "../../observability/metrics-registry.ts";
import type { WatchController, WatchFn } from "../../runtime/k8s/pod-watcher.ts";
import type { Logger } from "../types.ts";
import { bootK8sRuntime } from "./runtime-wiring.ts";

const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
};

/** Per-call counters over the fake K8s API surface the wiring drives. */
interface ApiCalls {
	listPods: number;
	listConfigMaps: number;
	deletePod: number;
	deleteConfigMap: number;
}

/** A `CoreV1Api` fake counting the four seam methods the wiring wraps. */
function fakeCoreApi(calls: ApiCalls): CoreV1Api {
	return {
		listNamespacedPod: async () => {
			calls.listPods++;
			return { items: [], metadata: { resourceVersion: "1" } };
		},
		listNamespacedConfigMap: async () => {
			calls.listConfigMaps++;
			return { items: [] };
		},
		deleteNamespacedPod: async () => {
			calls.deletePod++;
			return {};
		},
		deleteNamespacedConfigMap: async () => {
			calls.deleteConfigMap++;
			return {};
		},
	} as unknown as CoreV1Api;
}

/** A watch seam that stays open (never fires `onDone`) and counts connect/abort. */
class FakeWatch {
	connections = 0;
	aborts = 0;
	readonly watch: WatchFn = (_path, _query, _onEvent, _onDone) => {
		this.connections++;
		const controller: WatchController = {
			abort: () => {
				this.aborts++;
			},
		};
		return Promise.resolve(controller);
	};
}

/** Flush the microtask + timer queue so the started loops make their first pass. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("bootK8sRuntime", () => {
	test("returns undefined under the default (local) backend — constructs nothing", () => {
		const handle = bootK8sRuntime({
			env: {},
			metrics: new MetricsRegistry(),
			logger: silentLogger,
		});
		expect(handle).toBeUndefined();
	});

	test("returns undefined for an explicit WARREN_RUNTIME=local", () => {
		const handle = bootK8sRuntime({
			env: { WARREN_RUNTIME: "local" },
			metrics: new MetricsRegistry(),
			logger: silentLogger,
		});
		expect(handle).toBeUndefined();
	});

	test("constructs + starts the pod-watcher and pod-GC under WARREN_RUNTIME=k8s", async () => {
		const calls: ApiCalls = { listPods: 0, listConfigMaps: 0, deletePod: 0, deleteConfigMap: 0 };
		const api = fakeCoreApi(calls);
		const watch = new FakeWatch();
		const handle = bootK8sRuntime({
			env: { WARREN_RUNTIME: "k8s" },
			metrics: new MetricsRegistry(),
			logger: silentLogger,
			coreApi: () => api,
			watch: watch.watch,
		});
		expect(handle).toBeDefined();
		if (handle === undefined) return;

		await tick();
		// Watcher started: its initial relist listed pods and it opened a watch.
		expect(calls.listPods).toBeGreaterThan(0);
		expect(watch.connections).toBeGreaterThan(0);
		// GC started: its immediate sweep listed pods + configmaps.
		expect(calls.listConfigMaps).toBeGreaterThan(0);

		await handle.stop();
	});

	test("threads ONE shared coreApi factory (provider reuses the watcher/GC client)", () => {
		const calls: ApiCalls = { listPods: 0, listConfigMaps: 0, deletePod: 0, deleteConfigMap: 0 };
		const api = fakeCoreApi(calls);
		const watch = new FakeWatch();
		const factory = () => api;
		const handle = bootK8sRuntime({
			env: { WARREN_RUNTIME: "k8s" },
			metrics: new MetricsRegistry(),
			logger: silentLogger,
			coreApi: factory,
			watch: watch.watch,
		});
		expect(handle?.coreApi).toBe(factory);
		expect(handle?.coreApi()).toBe(api);
	});

	test("the watcher satisfies the three provider/metrics seams", () => {
		const watch = new FakeWatch();
		const handle = bootK8sRuntime({
			env: { WARREN_RUNTIME: "k8s" },
			metrics: new MetricsRegistry(),
			logger: silentLogger,
			coreApi: () =>
				fakeCoreApi({ listPods: 0, listConfigMaps: 0, deletePod: 0, deleteConfigMap: 0 }),
			watch: watch.watch,
		});
		// PodCacheReader + PodAdmissionSource + PodMetricsSource are all satisfied by
		// the single returned watcher — the shapes ServerDeps threads it into.
		expect(typeof handle?.podWatcher.getByRunId).toBe("function");
		expect(typeof handle?.podWatcher.admissionSnapshot).toBe("function");
		expect(typeof handle?.podWatcher.metricsSnapshot).toBe("function");
	});

	test("stop() aborts the watch and halts the loops", async () => {
		const calls: ApiCalls = { listPods: 0, listConfigMaps: 0, deletePod: 0, deleteConfigMap: 0 };
		const watch = new FakeWatch();
		const handle = bootK8sRuntime({
			env: { WARREN_RUNTIME: "k8s" },
			metrics: new MetricsRegistry(),
			logger: silentLogger,
			coreApi: () => fakeCoreApi(calls),
			watch: watch.watch,
		});
		expect(handle).toBeDefined();
		if (handle === undefined) return;

		await tick();
		await handle.stop();
		// The open watch was aborted on stop.
		expect(watch.aborts).toBeGreaterThan(0);

		// After stop, the loops make no further passes.
		const podsAfterStop = calls.listPods;
		const cmsAfterStop = calls.listConfigMaps;
		await tick();
		expect(calls.listPods).toBe(podsAfterStop);
		expect(calls.listConfigMaps).toBe(cmsAfterStop);

		// stop() is idempotent.
		await handle.stop();
	});
});

import { describe, expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import {
	METRIC_EVICTED_TOTAL,
	METRIC_INIT_FAILURES_TOTAL,
	METRIC_OOM_KILLED_TOTAL,
	METRIC_WATCH_RECONNECTS_TOTAL,
} from "./pod-metrics.ts";
import {
	AGENT_CONTAINER_NAME,
	INIT_CONTAINER_NAME,
	LABEL_PROJECT,
	LABEL_RUN_ID,
} from "./pod-spec.ts";
import {
	type CounterSink,
	type PodListFn,
	PodWatcher,
	type WatchController,
	type WatchFn,
	type WatchPhase,
} from "./pod-watcher.ts";

// --- Fakes ------------------------------------------------------------------

class FakeCounters implements CounterSink {
	readonly counts = new Map<string, number>();
	increment(name: string, _labels?: Readonly<Record<string, string>>, by = 1): void {
		this.counts.set(name, (this.counts.get(name) ?? 0) + by);
	}
	get(name: string): number {
		return this.counts.get(name) ?? 0;
	}
}

interface FakeConnection {
	query: Readonly<Record<string, string | number | boolean | undefined>>;
	onEvent: (phase: WatchPhase, obj: V1Pod) => void;
	onDone: (err: unknown) => void;
}

/** A watch seam whose connections are inspectable + drivable from a test. */
class FakeWatch {
	readonly connections: FakeConnection[] = [];
	aborts = 0;

	readonly watch: WatchFn = (_path, query, onEvent, onDone) => {
		this.connections.push({ query, onEvent, onDone });
		const controller: WatchController = {
			abort: () => {
				this.aborts++;
			},
		};
		return Promise.resolve(controller);
	};

	latest(): FakeConnection {
		const c = this.connections[this.connections.length - 1];
		if (c === undefined) throw new Error("no watch connection opened yet");
		return c;
	}
}

function listReturning(
	items: V1Pod[],
	resourceVersion = "100",
): { fn: PodListFn; calls: () => number } {
	let calls = 0;
	return {
		fn: async () => {
			calls++;
			return { items, resourceVersion };
		},
		calls: () => calls,
	};
}

/** A pod carrying the run-id label + a phase (+ optional resourceVersion). */
function podFor(runId: string, phase: string, resourceVersion?: string): V1Pod {
	return {
		metadata: {
			name: `run-${runId}`,
			labels: { [LABEL_RUN_ID]: runId },
			...(resourceVersion !== undefined ? { resourceVersion } : {}),
		},
		status: { phase },
	};
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until at least `n` watch connections have been opened. */
async function waitForConnections(watch: FakeWatch, n: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (watch.connections.length >= n) return;
		await delay(2);
	}
	throw new Error(`expected >=${n} connections, saw ${watch.connections.length}`);
}

function makeWatcher(
	list: PodListFn,
	watch: FakeWatch,
	metrics: CounterSink,
	now?: () => Date,
): PodWatcher {
	return new PodWatcher({
		list,
		watch: watch.watch,
		namespace: "warren-runs",
		metrics,
		backoffBaseMs: 1,
		backoffMaxMs: 4,
		...(now !== undefined ? { now } : {}),
	});
}

// --- Tests ------------------------------------------------------------------

describe("PodWatcher — startup + list-then-watch", () => {
	test("initial list seeds the cache and the first watch resumes from its resourceVersion", async () => {
		const list = listReturning([podFor("run_a", "Running")], "100");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch, new FakeCounters());
		watcher.start();
		await waitForConnections(watch, 1);

		expect(list.calls()).toBe(1);
		expect(watcher.getByRunId("run_a")?.status?.phase).toBe("Running");
		expect(watch.latest().query.labelSelector).toBe(LABEL_RUN_ID);
		expect(watch.latest().query.resourceVersion).toBe("100");
		await watcher.stop();
	});

	test("start() is idempotent — a second call opens no extra list/watch", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch, new FakeCounters());
		watcher.start();
		watcher.start();
		await waitForConnections(watch, 1);
		expect(list.calls()).toBe(1);
		expect(watch.connections).toHaveLength(1);
		await watcher.stop();
	});
});

describe("PodWatcher — event → cache + metrics", () => {
	test("ADDED/MODIFIED/DELETED reconcile the cache", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch, new FakeCounters());
		watcher.start();
		await waitForConnections(watch, 1);
		const conn = watch.latest();

		conn.onEvent("ADDED", podFor("run_x", "Pending"));
		expect(watcher.getByRunId("run_x")?.status?.phase).toBe("Pending");

		conn.onEvent("MODIFIED", podFor("run_x", "Running"));
		expect(watcher.getByRunId("run_x")?.status?.phase).toBe("Running");
		expect(watcher.metricsSnapshot().phaseCounts).toEqual({ Running: 1 });

		conn.onEvent("DELETED", podFor("run_x", "Running"));
		expect(watcher.getByRunId("run_x")).toBeUndefined();
		expect(watcher.metricsSnapshot().phaseCounts).toEqual({});
		await watcher.stop();
	});

	test("an OOMKilled pod bumps the OOM counter exactly once", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const metrics = new FakeCounters();
		const watcher = makeWatcher(list.fn, watch, metrics);
		watcher.start();
		await waitForConnections(watch, 1);
		const conn = watch.latest();

		const oomPod: V1Pod = {
			metadata: { name: "run-run_oom", labels: { [LABEL_RUN_ID]: "run_oom" } },
			status: {
				phase: "Failed",
				containerStatuses: [
					{
						name: AGENT_CONTAINER_NAME,
						image: "warren-agent:latest",
						imageID: "",
						ready: false,
						restartCount: 0,
						state: { terminated: { exitCode: 137, reason: "OOMKilled" } },
					},
				],
			},
		};
		conn.onEvent("ADDED", oomPod);
		conn.onEvent("MODIFIED", oomPod); // duplicate watch event — must not double-count
		expect(metrics.get(METRIC_OOM_KILLED_TOTAL)).toBe(1);
		await watcher.stop();
	});

	test("an evicted pod bumps the evicted counter exactly once (warren-c0cd)", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const metrics = new FakeCounters();
		const watcher = makeWatcher(list.fn, watch, metrics);
		watcher.start();
		await waitForConnections(watch, 1);
		const conn = watch.latest();

		const evictedPod: V1Pod = {
			metadata: { name: "run-run_evicted", labels: { [LABEL_RUN_ID]: "run_evicted" } },
			status: {
				phase: "Failed",
				reason: "Evicted",
				message: "Pod ephemeral local storage usage exceeds the total limit of containers 1Gi.",
				containerStatuses: [
					{
						name: AGENT_CONTAINER_NAME,
						image: "warren-agent:latest",
						imageID: "",
						ready: false,
						restartCount: 0,
						state: {
							terminated: {
								exitCode: 137,
								reason: "ContainerStatusUnknown",
								message: "The container could not be located when the pod was terminated",
							},
						},
					},
				],
			},
		};
		conn.onEvent("ADDED", evictedPod);
		conn.onEvent("MODIFIED", evictedPod); // duplicate watch event — must not double-count
		expect(metrics.get(METRIC_EVICTED_TOTAL)).toBe(1);
		// an eviction is NOT an OOM kill — the two counters stay distinct.
		expect(metrics.get(METRIC_OOM_KILLED_TOTAL)).toBe(0);
		await watcher.stop();
	});

	test("a failed workspace-init records its duration + bumps the init-failure counter", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const metrics = new FakeCounters();
		const watcher = makeWatcher(list.fn, watch, metrics);
		watcher.start();
		await waitForConnections(watch, 1);

		const pod: V1Pod = {
			metadata: { name: "run-run_init", labels: { [LABEL_RUN_ID]: "run_init" } },
			status: {
				phase: "Failed",
				initContainerStatuses: [
					{
						name: INIT_CONTAINER_NAME,
						image: "warren-workspace-init:latest",
						imageID: "",
						ready: false,
						restartCount: 0,
						state: {
							terminated: {
								exitCode: 1,
								reason: "Error",
								startedAt: new Date("2026-07-12T00:00:00Z"),
								finishedAt: new Date("2026-07-12T00:00:04Z"),
							},
						},
					},
				],
			},
		};
		watch.latest().onEvent("ADDED", pod);
		expect(metrics.get(METRIC_INIT_FAILURES_TOTAL)).toBe(1);
		expect(watcher.metricsSnapshot().lastInitDurationSeconds).toBe(4);
		await watcher.stop();
	});

	test("pending-duration gauge reads the longest currently-Pending pod's age", async () => {
		const now = new Date("2026-07-12T00:01:00Z");
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch, new FakeCounters(), () => now);
		watcher.start();
		await waitForConnections(watch, 1);

		const pod: V1Pod = {
			metadata: {
				name: "run-run_p",
				labels: { [LABEL_RUN_ID]: "run_p" },
				creationTimestamp: new Date("2026-07-12T00:00:30Z"),
			},
			status: { phase: "Pending" },
		};
		watch.latest().onEvent("ADDED", pod);
		expect(watcher.metricsSnapshot().pendingDurationSeconds).toBe(30);
		await watcher.stop();
	});

	test("BOOKMARK advances the resume cursor without touching the cache", async () => {
		const list = listReturning([], "10");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch, new FakeCounters());
		watcher.start();
		await waitForConnections(watch, 1);
		watch.latest().onEvent("BOOKMARK", { metadata: { resourceVersion: "205" } });
		// Force a reconnect and assert the bookmark rv is what we resume from.
		watch.latest().onDone(new Error("disconnect"));
		await waitForConnections(watch, 2);
		expect(watch.latest().query.resourceVersion).toBe("205");
		await watcher.stop();
	});
});

describe("PodWatcher — reconnect story", () => {
	test("a transient disconnect reconnects, counts, and resumes from the last resourceVersion", async () => {
		const list = listReturning([], "100");
		const watch = new FakeWatch();
		const metrics = new FakeCounters();
		const watcher = makeWatcher(list.fn, watch, metrics);
		watcher.start();
		await waitForConnections(watch, 1);

		// Advance the resume cursor via an event, then drop the connection.
		watch.latest().onEvent("MODIFIED", podFor("run_a", "Running", "150"));
		watch.latest().onDone(new Error("network blip"));
		await waitForConnections(watch, 2);

		expect(metrics.get(METRIC_WATCH_RECONNECTS_TOTAL)).toBe(1);
		expect(watch.latest().query.resourceVersion).toBe("150");
		// No relist on a transient disconnect — still the single startup list.
		expect(list.calls()).toBe(1);
		await watcher.stop();
	});

	test("a 410 Gone forces a relist (refreshing the cache + resourceVersion)", async () => {
		let listCalls = 0;
		const items: V1Pod[][] = [
			[podFor("run_a", "Running", "100")],
			[podFor("run_b", "Pending", "300")],
		];
		const list: PodListFn = async () => {
			const page = items[Math.min(listCalls, items.length - 1)] ?? [];
			const rv = listCalls === 0 ? "100" : "300";
			listCalls++;
			return { items: page, resourceVersion: rv };
		};
		const watch = new FakeWatch();
		const metrics = new FakeCounters();
		const watcher = makeWatcher(list, watch, metrics);
		watcher.start();
		await waitForConnections(watch, 1);
		expect(watcher.getByRunId("run_a")).toBeDefined();

		// 410: resourceVersion aged out → relist.
		const err = Object.assign(new Error("too old resource version"), { code: 410 });
		watch.latest().onDone(err);
		await waitForConnections(watch, 2);

		expect(listCalls).toBe(2); // startup + relist
		expect(metrics.get(METRIC_WATCH_RECONNECTS_TOTAL)).toBe(1);
		// Cache reconciled to the relist truth: run_a gone, run_b present.
		expect(watcher.getByRunId("run_a")).toBeUndefined();
		expect(watcher.getByRunId("run_b")?.status?.phase).toBe("Pending");
		expect(watch.latest().query.resourceVersion).toBe("300");
		await watcher.stop();
	});
});

describe("PodWatcher — lifecycle", () => {
	test("stop() aborts the active watch and halts the loop", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch, new FakeCounters());
		watcher.start();
		await waitForConnections(watch, 1);
		await watcher.stop();
		expect(watch.aborts).toBeGreaterThanOrEqual(1);

		// After stop, dropping the (now-defunct) connection must not reconnect.
		const before = watch.connections.length;
		watch.latest().onDone(new Error("late"));
		await delay(20);
		expect(watch.connections.length).toBe(before);
	});

	test("stop() is safe before any connection settles", async () => {
		const list = listReturning([], "1");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch, new FakeCounters());
		watcher.start();
		await watcher.stop();
		expect(true).toBe(true);
	});
});

describe("PodWatcher.admissionSnapshot (warren-b6f2)", () => {
	function runPod(runId: string, phase: string, projectId?: string): V1Pod {
		return {
			metadata: {
				name: `run-${runId}`,
				labels: {
					[LABEL_RUN_ID]: runId,
					...(projectId !== undefined ? { [LABEL_PROJECT]: projectId } : {}),
				},
			},
			status: { phase },
		};
	}

	test("tallies non-terminal / pending / per-project counts off the live cache", async () => {
		const list = listReturning(
			[
				runPod("run_a", "Pending", "proj_hot"),
				runPod("run_b", "Running", "proj_hot"),
				runPod("run_c", "Running", "proj_cold"),
				runPod("run_d", "Succeeded", "proj_hot"),
				runPod("run_e", "Failed", "proj_hot"),
			],
			"100",
		);
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch, new FakeCounters());
		watcher.start();
		await waitForConnections(watch, 1);

		expect(watcher.admissionSnapshot("proj_hot")).toEqual({
			nonTerminalPods: 3, // a (Pending) + b + c (Running); terminals excluded
			pendingPods: 1, // a
			projectNonTerminalPods: 2, // a + b (proj_hot terminals excluded)
		});
		// A project with no active pods → zero project count, same cluster totals.
		expect(watcher.admissionSnapshot("proj_none").projectNonTerminalPods).toBe(0);
		await watcher.stop();
	});
});

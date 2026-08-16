import { describe, expect, test } from "bun:test";
import type { CoreV1Event } from "@kubernetes/client-node";
import type { ListWatchFn, WatchController, WatchPhase } from "./list-watch.ts";
import { type EventListFn, PodEventWatcher, type PodWarningSignal } from "./pod-event-watcher.ts";

// --- Fakes ------------------------------------------------------------------

interface FakeConnection {
	query: Readonly<Record<string, string | number | boolean | undefined>>;
	onEvent: (phase: WatchPhase, obj: CoreV1Event) => void;
	onDone: (err: unknown) => void;
}

/** A watch seam whose connections are inspectable + drivable from a test. */
class FakeEventWatch {
	readonly connections: FakeConnection[] = [];

	readonly watch: ListWatchFn<CoreV1Event> = (_path, query, onEvent, onDone) => {
		this.connections.push({ query, onEvent, onDone });
		const controller: WatchController = { abort: () => {} };
		return Promise.resolve(controller);
	};

	latest(): FakeConnection {
		const c = this.connections[this.connections.length - 1];
		if (c === undefined) throw new Error("no watch connection opened yet");
		return c;
	}
}

function listReturning(
	items: CoreV1Event[],
	resourceVersion = "100",
): { fn: EventListFn; calls: () => number } {
	let calls = 0;
	return {
		fn: async () => {
			calls++;
			return { items, resourceVersion };
		},
		calls: () => calls,
	};
}

/** A Warning event against pod `run-<pod>`, as the kubelet reports it. */
function warningEvent(
	podName: string,
	reason: string,
	message: string,
	uid: string,
	count = 1,
): CoreV1Event {
	return {
		metadata: { name: `${podName}.${uid}`, uid },
		involvedObject: { kind: "Pod", name: podName, namespace: "warren-runs" },
		type: "Warning",
		reason,
		message,
		count,
		firstTimestamp: new Date("2026-07-30T17:40:00Z"),
		lastTimestamp: new Date("2026-07-30T17:57:00Z"),
	};
}

interface Harness {
	watcher: PodEventWatcher;
	watch: FakeEventWatch;
	signals: PodWarningSignal[];
	listCalls: () => number;
}

/** Pods `run-a`→`run_aaa` (phase Pending) and `run-b`→`run_bbb` (phase Running). */
function makeWatcher(list: EventListFn, watch: FakeEventWatch): Harness {
	const signals: PodWarningSignal[] = [];
	const podNames = new Map([
		["run-a", "run_aaa"],
		["run-b", "run_bbb"],
	]);
	const phases = new Map([
		["run_aaa", "Pending"],
		["run_bbb", "Running"],
	]);
	const watcher = new PodEventWatcher({
		list,
		watch: watch.watch,
		namespace: "warren-runs",
		runIdForPodName: (podName) => podNames.get(podName),
		podPhaseForRunId: (runId) => phases.get(runId),
		onWarning: (signal) => signals.push(signal),
		backoffBaseMs: 1,
		backoffMaxMs: 4,
		resyncPeriodMs: 0,
	});
	return { watcher, watch, signals, listCalls: () => 0 };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForConnections(watch: FakeEventWatch, n: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (watch.connections.length >= n) return;
		await delay(2);
	}
	throw new Error(`expected >=${n} connections, saw ${watch.connections.length}`);
}

// --- Tests ------------------------------------------------------------------

describe("PodEventWatcher", () => {
	test("emits a structured signal for a pod warning event (warren-32f8)", async () => {
		const list = listReturning([]);
		const watch = new FakeEventWatch();
		const h = makeWatcher(list.fn, watch);
		h.watcher.start();
		await waitForConnections(watch, 1);
		watch
			.latest()
			.onEvent(
				"ADDED",
				warningEvent(
					"run-a",
					"FailedAttachVolume",
					"Multi-Attach error for volume pvc-123: volume is already used by pod cache-xyz",
					"uid-1",
				),
			);
		expect(h.signals).toHaveLength(1);
		const signal = h.signals[0];
		expect(signal?.runId).toBe("run_aaa");
		expect(signal?.reason).toBe("FailedAttachVolume");
		expect(signal?.message).toContain("Multi-Attach error");
		expect(signal?.podName).toBe("run-a");
		expect(signal?.podPhase).toBe("Pending");
		expect(signal?.count).toBe(1);
		expect(signal?.firstTimestamp).toBe("2026-07-30T17:40:00.000Z");
		expect(signal?.lastTimestamp).toBe("2026-07-30T17:57:00.000Z");
		expect(signal?.eventName).toBe("run-a.uid-1");
		await h.watcher.stop();
	});

	test("watches with the type=Warning field selector so healthy startups stay silent", async () => {
		const list = listReturning([]);
		const watch = new FakeEventWatch();
		const h = makeWatcher(list.fn, watch);
		h.watcher.start();
		await waitForConnections(watch, 1);
		expect(watch.latest().query.fieldSelector).toBe("type=Warning");
		expect(h.signals).toHaveLength(0);
		await h.watcher.stop();
	});

	test("repeated deliveries of the same event object (count climbing) emit once", async () => {
		const list = listReturning([]);
		const watch = new FakeEventWatch();
		const h = makeWatcher(list.fn, watch);
		h.watcher.start();
		await waitForConnections(watch, 1);
		// The kubelet updates the SAME event object as the condition refires —
		// a 17-minute stall is dozens of MODIFIED deliveries of one uid.
		for (let count = 1; count <= 50; count++) {
			watch
				.latest()
				.onEvent(
					"MODIFIED",
					warningEvent("run-a", "FailedAttachVolume", "still wedged", "uid-1", count),
				);
		}
		expect(h.signals).toHaveLength(1);
		expect(h.signals[0]?.count).toBe(1);
		await h.watcher.stop();
	});

	test("a relist after reconnect re-delivers the live page without re-flooding", async () => {
		const initial = warningEvent("run-a", "FailedAttachVolume", "wedged", "uid-1", 7);
		const list = listReturning([initial]);
		const watch = new FakeEventWatch();
		const h = makeWatcher(list.fn, watch);
		h.watcher.start();
		await waitForConnections(watch, 1);
		// The initial list seeds one signal...
		expect(h.signals).toHaveLength(1);
		// ...and a 410-forced relist of the same page adds none.
		watch.latest().onDone({ code: 410 });
		await waitForConnections(watch, 2);
		expect(h.signals).toHaveLength(1);
		await h.watcher.stop();
	});

	test("a distinct condition (new event object) emits a fresh signal", async () => {
		const list = listReturning([]);
		const watch = new FakeEventWatch();
		const h = makeWatcher(list.fn, watch);
		h.watcher.start();
		await waitForConnections(watch, 1);
		watch
			.latest()
			.onEvent("ADDED", warningEvent("run-a", "FailedScheduling", "0/3 nodes", "uid-1"));
		watch.latest().onEvent("ADDED", warningEvent("run-a", "FailedAttachVolume", "wedged", "uid-2"));
		watch
			.latest()
			.onEvent("ADDED", warningEvent("run-b", "BackOff", "back-off pulling image", "uid-3"));
		expect(h.signals.map((s) => s.reason)).toEqual([
			"FailedScheduling",
			"FailedAttachVolume",
			"BackOff",
		]);
		expect(h.signals[2]?.runId).toBe("run_bbb");
		expect(h.signals[2]?.podPhase).toBe("Running");
		await h.watcher.stop();
	});

	test("drops events for unknown pods and non-Pod objects", async () => {
		const list = listReturning([]);
		const watch = new FakeEventWatch();
		const h = makeWatcher(list.fn, watch);
		h.watcher.start();
		await waitForConnections(watch, 1);
		watch.latest().onEvent("ADDED", warningEvent("run-foreign", "FailedScheduling", "?", "uid-1"));
		const nodeEvent = warningEvent("run-a", "NodeNotReady", "node lost", "uid-2");
		nodeEvent.involvedObject = { kind: "Node", name: "ip-10-0-0-1" };
		watch.latest().onEvent("ADDED", nodeEvent);
		expect(h.signals).toHaveLength(0);
		await h.watcher.stop();
	});

	test("truncates long messages to the budget", async () => {
		const list = listReturning([]);
		const watch = new FakeEventWatch();
		const h = makeWatcher(list.fn, watch);
		h.watcher.start();
		await waitForConnections(watch, 1);
		const longMessage = "x".repeat(900);
		watch.latest().onEvent("ADDED", warningEvent("run-a", "Failed", longMessage, "uid-1"));
		expect(h.signals[0]?.message.length).toBe(501); // 500 + ellipsis
		await h.watcher.stop();
	});
});

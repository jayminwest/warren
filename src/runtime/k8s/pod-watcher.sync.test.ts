/**
 * `PodWatcher.isSynced()` — the informer sync-state seam (warren-39e1) the
 * `/readyz` `k8s_api_reachable` check consults. `true` once the initial list
 * has seeded the cache and a watch stream is attached; `false` before the
 * first successful list, after a list failure, and after a watch error —
 * i.e. whenever the K8s API server is unreachable from this pod.
 */

import { describe, expect, test } from "bun:test";
import { FakeCounters, FakeWatch, listReturning, waitForConnections } from "./pod-watcher.test.ts";
import { type PodListFn, PodWatcher, type WatchFn } from "./pod-watcher.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeWatcher(list: PodListFn, watch: FakeWatch | WatchFn): PodWatcher {
	return new PodWatcher({
		list,
		watch: typeof watch === "function" ? watch : watch.watch,
		namespace: "warren-runs",
		metrics: new FakeCounters(),
		backoffBaseMs: 1,
		backoffMaxMs: 4,
		resyncPeriodMs: 0,
	});
}

describe("PodWatcher.isSynced (warren-39e1)", () => {
	test("unsynced before the initial list succeeds; synced once watching", async () => {
		const list = listReturning([], "100");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch);
		expect(watcher.isSynced()).toBe(false);
		watcher.start();
		await waitForConnections(watch, 1);
		expect(watcher.isSynced()).toBe(true);
		await watcher.stop();
	});

	test("list failure (API unreachable) leaves the watcher unsynced", async () => {
		let calls = 0;
		const watch = new FakeWatch();
		// API unreachable: the watch attach rejects alongside the list.
		const rejectWatch: WatchFn = () => Promise.reject(new Error("connection refused"));
		const watcher = makeWatcher(async () => {
			calls++;
			throw new Error("connection refused");
		}, rejectWatch);
		watcher.start();
		for (let i = 0; i < 200 && calls < 2; i++) await delay(2);
		expect(watcher.isSynced()).toBe(false);
		expect(watch.connections.length).toBe(0);
		await watcher.stop();
	});

	test("a watch stream error flips synced to false until re-attach", async () => {
		const list = listReturning([], "100");
		const watch = new FakeWatch();
		const watcher = makeWatcher(list.fn, watch);
		watcher.start();
		await waitForConnections(watch, 1);
		expect(watcher.isSynced()).toBe(true);
		// The stream breaks with an API error → unsynced…
		watch.latest().onDone(new Error("EOF"));
		for (let i = 0; i < 200 && watcher.isSynced(); i++) await delay(2);
		expect(watcher.isSynced()).toBe(false);
		// …and the reconnect re-attaches → synced again.
		await waitForConnections(watch, 2);
		expect(watcher.isSynced()).toBe(true);
		await watcher.stop();
	});
});

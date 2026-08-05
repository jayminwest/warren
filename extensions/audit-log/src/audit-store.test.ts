import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "./audit-store.ts";
import { createClient } from "./client.ts";
import { collectOnce } from "./collector.ts";
import { CursorStore } from "./cursor-store.ts";
import { FakeWarren } from "./fake-warren.ts";
import type { RunEvent } from "./wire.ts";

const CLOCK = () => new Date("2026-08-04T12:00:00Z");

function event(kind: string, payload: unknown, over: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 1,
		runId: "run-1",
		seq: 1,
		ts: "2026-08-04T10:00:00Z",
		kind,
		stream: "system",
		payload,
		...over,
	};
}

describe("AuditStore", () => {
	test("appends rows with monotonic ids and unknown actor kind", () => {
		const store = new AuditStore(":memory:", { now: CLOCK });
		store.apply(event("steer.sent", { body: "a" }, { seq: 1 }));
		store.apply(event("steer.sent", { body: "b" }, { seq: 2 }));
		const rows = store.all();
		expect(rows.map((r) => r.event)).toEqual([
			"run.dispatched",
			"run.started",
			"run.steered",
			"run.steered",
		]);
		expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
		expect(rows.every((r) => r.actorKind === "unknown")).toBe(true);
		expect(store.maxId()).toBe(4);
		store.close();
	});

	test("replay is an exact no-op: same rows, same ids, no timestamp drift", () => {
		const store = new AuditStore(":memory:", { now: CLOCK });
		const feed = (): void => {
			store.apply(event("message", {}, { seq: 1 }));
			store.apply(event("steer.sent", { body: "x" }, { seq: 2 }));
			store.apply(event("reap.pr_opened", { prUrl: "u" }, { seq: 3 }));
			store.apply(
				event("reap.completed", { state: "succeeded", branchPushed: true }, { seq: 4 }),
			);
			store.observeRun({ id: "run-1", state: "succeeded" });
		};
		feed();
		const before = store.all();
		feed();
		feed();
		expect(store.all()).toEqual(before);
		expect(store.count()).toBe(before.length);
		store.close();
	});

	test("run.started still lands when the run was first sighted via observeRun", () => {
		const store = new AuditStore(":memory:", { now: CLOCK });
		store.observeRun({ id: "run-1", state: "queued" });
		expect(store.all().map((r) => r.event)).toEqual(["run.dispatched"]);
		store.apply(event("message", {}, { seq: 5 }));
		expect(store.all().map((r) => r.event)).toEqual([
			"run.dispatched",
			"run.started",
		]);
		store.close();
	});

	test("event-derived terminal wins over the later list-derived candidate", () => {
		const store = new AuditStore(":memory:", { now: CLOCK });
		store.apply(
			event("reap.completed", { state: "succeeded", branchPushed: false }, { seq: 9 }),
		);
		store.observeRun({ id: "run-1", state: "succeeded" });
		const terminal = store.all().find((r) => r.event === "run.terminal");
		expect(terminal?.at).toBe("2026-08-04T10:00:00Z");
		expect(terminal?.detail).toEqual({ state: "succeeded", source: "reap.completed" });
		store.close();
	});

	test("rowsSince pages the append-only log with no skips or duplicates", () => {
		const store = new AuditStore(":memory:", { now: CLOCK });
		for (let seq = 1; seq <= 5; seq++) {
			store.apply(event("steer.sent", { body: `s${seq}` }, { seq }));
		}
		const first = store.rowsSince(0, 3);
		const second = store.rowsSince(first[first.length - 1]?.id ?? 0, 50);
		expect([...first, ...second].map((r) => r.id)).toEqual(store.all().map((r) => r.id));
		store.close();
	});

	test("persists across reopen on the same file", () => {
		const dir = mkdtempSync(join(tmpdir(), "audit-store-"));
		try {
			const path = join(dir, "audit.db");
			const first = new AuditStore(path, { now: CLOCK });
			first.apply(event("steer.sent", { body: "x" }, { seq: 1 }));
			first.close();
			const second = new AuditStore(path, { now: CLOCK });
			expect(second.count()).toBe(3);
			second.apply(event("steer.sent", { body: "x" }, { seq: 1 }));
			expect(second.count()).toBe(3);
			second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("AuditStore over a fake warren lifecycle", () => {
	let fake: FakeWarren;
	let dir: string;
	beforeEach(() => {
		fake = new FakeWarren();
		fake.start();
		dir = mkdtempSync(join(tmpdir(), "audit-e2e-"));
	});
	afterEach(() => {
		fake.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	function seedLifecycle(): void {
		fake.addRun({ id: "run-1", state: "running", startedAt: "2026-08-04T09:00:00Z" });
		fake.addEvent("run-1", { id: 1, seq: 1, ts: "2026-08-04T09:00:01Z", kind: "message", stream: "stdout", payload: {} });
		fake.addEvent("run-1", {
			id: 2,
			seq: 2,
			ts: "2026-08-04T09:05:00Z",
			kind: "steer.sent",
			stream: "system",
			payload: { messageId: "m-1", priority: "normal", fromActor: "operator", body: "hi" },
		});
		fake.addEvent("run-1", {
			id: 3,
			seq: 3,
			ts: "2026-08-04T09:10:00Z",
			kind: "reap.pr_opened",
			stream: "system",
			payload: { prUrl: "https://example/pr/1", mode: "created", branch: "b", baseBranch: "main" },
		});
		fake.addEvent("run-1", {
			id: 4,
			seq: 4,
			ts: "2026-08-04T09:15:00Z",
			kind: "reap.completed",
			stream: "system",
			payload: { state: "succeeded", branchPushed: true, commitsAhead: 1 },
		});
	}

	async function cycle(dbPath: string): Promise<void> {
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		const cursors = new CursorStore(dbPath);
		const sink = new AuditStore(dbPath, { now: CLOCK });
		await collectOnce({ client, store: cursors, sink, now: CLOCK });
		cursors.close();
		sink.close();
	}

	test("produces the six lifecycle rows exactly once, across a kill-and-restart", async () => {
		seedLifecycle();
		const dbPath = join(dir, "audit.db");

		// First cycle tails only partway, then the collector "dies".
		await cycle(dbPath);
		// Warren terminalizes the run; the restarted collector re-lists and re-tails.
		fake.runs[0] = { id: "run-1", state: "succeeded", startedAt: "2026-08-04T09:00:00Z" };
		await cycle(dbPath);
		// A third cycle is a pure replay: drained cursor, no new facts.
		await cycle(dbPath);

		const store = new AuditStore(dbPath, { now: CLOCK });
		const rows = store.rowsForRun("run-1");
		expect(rows.map((r) => r.event)).toEqual([
			"run.dispatched",
			"run.started",
			"run.steered",
			"pr.opened",
			"run.terminal",
			"branch.pushed",
		]);
		expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
		// Event-derived timestamps, never the injected clock, for event facts.
		expect(rows[2]?.at).toBe("2026-08-04T09:05:00Z");
		expect(rows[4]?.at).toBe("2026-08-04T09:15:00Z");
		expect(rows[4]?.detail).toEqual({ state: "succeeded", source: "reap.completed" });
		store.close();
	});
});

describe("AuditStore retention", () => {
	function storeWithRows(n: number): AuditStore {
		const store = new AuditStore(":memory:", { now: CLOCK });
		for (let i = 1; i <= n; i++) {
			store.apply(
				event("steer.sent", { body: `b${i}` }, { runId: `run-${i}`, seq: i, id: i }),
			);
		}
		return store;
	}

	test("maxRows keeps the newest rows and deletes oldest-first", () => {
		const store = storeWithRows(5); // 3 rows per run: dispatched + started + steered
		const deleted = store.pruneRetention({ maxRows: 4 });
		expect(deleted).toBe(11);
		expect(store.count()).toBe(4);
		expect(store.all().map((r) => r.id)).toEqual([12, 13, 14, 15]);
		store.close();
	});

	test("maxAgeMs drops rows older than the horizon", () => {
		const store = new AuditStore(":memory:", { now: CLOCK });
		store.apply(event("steer.sent", {}, { seq: 1, ts: "2026-08-01T00:00:00Z" }));
		store.apply(event("steer.sent", {}, { seq: 2, ts: "2026-08-04T11:59:00Z" }));
		const deleted = store.pruneRetention({
			maxAgeMs: 3_600_000,
			now: new Date("2026-08-04T12:00:00Z"),
		});
		// First event's three rows (dispatched, started, steered) carry the
		// old event ts and fall under the horizon; the second steer survives.
		expect(deleted).toBe(3);
		expect(store.all().map((r) => r.event)).toEqual(["run.steered"]);
		store.close();
	});

	test("zero bounds disable retention entirely", () => {
		const store = storeWithRows(3);
		expect(store.pruneRetention({})).toBe(0);
		expect(store.count()).toBe(9);
		store.close();
	});
});

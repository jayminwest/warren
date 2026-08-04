import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "./client.ts";
import { type EventSink, collectOnce, runCollector } from "./collector.ts";
import { CursorStore } from "./cursor-store.ts";
import { FakeWarren } from "./fake-warren.ts";
import type { RunEvent } from "./wire.ts";

class RecordingSink implements EventSink {
	readonly events: RunEvent[] = [];
	/** Seq values that should throw on apply — chaos knob for mid-page failure. */
	failOnSeq: number | null = null;
	apply(event: RunEvent): void {
		if (this.failOnSeq !== null && event.seq === this.failOnSeq) {
			throw new Error(`sink boom at seq ${event.seq}`);
		}
		this.events.push(event);
	}
}

function fixedClock(): () => Date {
	return () => new Date("2026-08-04T12:00:00Z");
}

function addEvents(fake: FakeWarren, runId: string, from: number, to: number): void {
	for (let seq = from; seq <= to; seq++) {
		fake.addEvent(runId, {
			id: seq,
			seq,
			ts: "2026-08-04T00:00:00Z",
			kind: "message",
			stream: "stdout",
			payload: { n: seq },
		});
	}
}

describe("collectOnce", () => {
	let fake: FakeWarren;
	beforeEach(() => {
		fake = new FakeWarren();
		fake.start();
	});
	afterEach(() => fake.stop());

	function deps(store: CursorStore, sink: RecordingSink) {
		return {
			client: createClient({ baseUrl: fake.baseUrl, token: "t" }),
			store,
			sink,
			now: fixedClock(),
		};
	}

	test("discovers runs across list pages and tails each one", async () => {
		for (let i = 0; i < 6; i++) {
			fake.addRun({ id: `r${i}`, state: "running", startedAt: `2026-08-04T00:00:0${i}Z` });
			addEvents(fake, `r${i}`, 1, 2);
		}
		const store = new CursorStore(":memory:");
		const sink = new RecordingSink();

		const stats = await collectOnce({ ...deps(store, sink), runsPageSize: 4 });

		expect(stats.runsDiscovered).toBe(6);
		expect(stats.eventsApplied).toBe(12);
		expect(store.get("r0").lastSeq).toBe(2);
		store.close();
	});

	test("applies events in seq order and checkpoints after each", async () => {
		fake.addRun({ id: "r1", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		addEvents(fake, "r1", 1, 1200);
		const store = new CursorStore(":memory:");
		const sink = new RecordingSink();

		const stats = await collectOnce({ ...deps(store, sink), eventsPageSize: 500 });

		expect(stats.eventsApplied).toBe(1200);
		expect(sink.events.map((e) => e.seq)).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
		expect(store.get("r1").lastSeq).toBe(1200);
		store.close();
	});

	test("a second cycle applies only new events — no duplicates", async () => {
		fake.addRun({ id: "r1", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		addEvents(fake, "r1", 1, 3);
		const store = new CursorStore(":memory:");
		const sink = new RecordingSink();
		const d = deps(store, sink);

		await collectOnce(d);
		addEvents(fake, "r1", 4, 5);
		const stats = await collectOnce(d);

		expect(stats.eventsApplied).toBe(2);
		expect(sink.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
		store.close();
	});

	test("a terminal run fully drained is marked drained and never re-tailed", async () => {
		fake.addRun({ id: "r1", state: "succeeded", startedAt: "2026-08-04T00:00:00Z" });
		addEvents(fake, "r1", 1, 3);
		const store = new CursorStore(":memory:");
		const sink = new RecordingSink();
		const d = deps(store, sink);

		await collectOnce(d);
		expect(store.get("r1").drained).toBe(true);

		fake.requestCounts.clear();
		const stats = await collectOnce(d);
		expect(stats.eventsApplied).toBe(0);
		// Discovery still lists runs; the drained run costs zero tail requests.
		expect(fake.requestCounts.get("GET /runs/:id/events") ?? 0).toBe(0);
		store.close();
	});

	test("a non-terminal run is re-tailed every cycle but not marked drained", async () => {
		fake.addRun({ id: "r1", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		const store = new CursorStore(":memory:");
		const sink = new RecordingSink();
		const d = deps(store, sink);

		await collectOnce(d);
		expect(store.get("r1").drained).toBe(false);
		fake.requestCounts.clear();
		await collectOnce(d);
		expect(fake.requestCounts.get("GET /runs/:id/events")).toBe(1);
		store.close();
	});

	test("durable resume: a fresh collector on the same store continues from the cursor", async () => {
		fake.addRun({ id: "r1", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		addEvents(fake, "r1", 1, 5);
		const store = new CursorStore(":memory:");
		const sink1 = new RecordingSink();
		await collectOnce(deps(store, sink1));

		// Collector "restarts": new sink, same store. Events 6+ arrive meanwhile.
		addEvents(fake, "r1", 6, 8);
		const sink2 = new RecordingSink();
		const stats = await collectOnce(deps(store, sink2));

		expect(stats.eventsApplied).toBe(3);
		expect(sink2.events.map((e) => e.seq)).toEqual([6, 7, 8]);
		store.close();
	});

	test("at-least-once: a sink failure mid-page leaves the cursor behind and replays", async () => {
		fake.addRun({ id: "r1", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		addEvents(fake, "r1", 1, 5);
		const store = new CursorStore(":memory:");
		const sink = new RecordingSink();
		sink.failOnSeq = 3;
		const runErrors: string[] = [];
		const d = { ...deps(store, sink), onRunError: (id: string) => runErrors.push(id) };

		// tailRun throws mid-page, so its partial progress is absent from the
		// cycle stats — but the CURSOR holds the true position (2), which is
		// what the resume guarantee reads.
		const first = await collectOnce(d);
		expect(first.eventsApplied).toBe(0);
		expect(runErrors).toEqual(["r1"]);
		expect(store.get("r1").lastSeq).toBe(2);

		sink.failOnSeq = null;
		const second = await collectOnce(d);
		expect(second.eventsApplied).toBe(3);
		expect(sink.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
		store.close();
	});

	test("one failing run does not starve the others", async () => {
		fake.addRun({ id: "bad", state: "running", startedAt: "2026-08-04T00:00:01Z" });
		fake.addRun({ id: "good", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		addEvents(fake, "bad", 1, 1);
		addEvents(fake, "good", 1, 2);
		const store = new CursorStore(":memory:");
		const applied: RunEvent[] = [];
		const runErrors: string[] = [];
		const selectiveSink: EventSink = {
			apply: (e) => {
				if (e.runId === "bad") throw new Error("boom");
				applied.push(e);
			},
		};

		const stats = await collectOnce({
			client: createClient({ baseUrl: fake.baseUrl, token: "t" }),
			store,
			sink: selectiveSink,
			now: fixedClock(),
			onRunError: (id) => runErrors.push(id),
		});

		expect(runErrors).toEqual(["bad"]);
		expect(stats.eventsApplied).toBe(2);
		expect(applied.map((e) => e.runId)).toEqual(["good", "good"]);
		expect(store.get("good").lastSeq).toBe(2);
		expect(store.get("bad").lastSeq).toBe(0);
		store.close();
	});
});

describe("runCollector", () => {
	let fake: FakeWarren;
	beforeEach(() => {
		fake = new FakeWarren();
		fake.start();
	});
	afterEach(() => fake.stop());

	test("cycles until the abort signal fires", async () => {
		fake.addRun({ id: "r1", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		addEvents(fake, "r1", 1, 1);
		const store = new CursorStore(":memory:");
		const sink = new RecordingSink();
		const ctrl = new AbortController();
		let cycles = 0;

		await runCollector({
			client: createClient({ baseUrl: fake.baseUrl, token: "t" }),
			store,
			sink,
			now: fixedClock(),
			pollIntervalMs: 1,
			signal: ctrl.signal,
			sleep: async () => {
				cycles += 1;
				if (cycles === 3) ctrl.abort();
			},
		});

		expect(cycles).toBe(3);
		expect(sink.events.map((e) => e.seq)).toEqual([1]);
		store.close();
	});

	test("a cycle-level failure (warren down) is reported and the loop survives", async () => {
		const store = new CursorStore(":memory:");
		const sink = new RecordingSink();
		const ctrl = new AbortController();
		const cycleErrors: unknown[] = [];
		fake.failWithStatus = 503;
		let cycles = 0;

		await runCollector({
			client: createClient({ baseUrl: fake.baseUrl, token: "t" }),
			store,
			sink,
			pollIntervalMs: 1,
			signal: ctrl.signal,
			onCycleError: (err) => cycleErrors.push(err),
			sleep: async () => {
				cycles += 1;
				if (cycles === 2) ctrl.abort();
			},
		});

		expect(cycleErrors.length).toBe(2);
		store.close();
	});

	test("observeRun fires once per discovered run per cycle, after the tail", async () => {
		fake.addRun({ id: "r1", state: "succeeded", startedAt: "2026-08-04T00:00:00Z" });
		addEvents(fake, "r1", 1, 2);
		const store = new CursorStore(":memory:");
		const seen: string[] = [];
		const sink = new RecordingSink();
		const stats = await collectOnce({
			client: createClient({ baseUrl: fake.baseUrl, token: "t" }),
			store,
			now: fixedClock(),
			sink: Object.assign(sink, {
				observeRun: (run: { id: string; state: string }) => {
					seen.push(`${run.id}:${run.state}:applied=${sink.events.length}`);
				},
			}),
		});
		expect(stats.runsTailed).toBe(1);
		expect(seen).toEqual(["r1:succeeded:applied=2"]);
		store.close();
	});
});

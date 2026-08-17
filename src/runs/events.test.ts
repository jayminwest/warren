import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { EventRow } from "../db/schema.ts";
import { RunEventBroker, tailRunEvents } from "./events.ts";

function makeEvent(runId: string, seq: number): EventRow {
	return {
		id: seq,
		runId,
		sandboxEventSeq: seq,
		ts: new Date(2026, 4, 8, 12, 0, seq).toISOString(),
		kind: "text",
		stream: "stdout",
		origin: null,
		payloadJson: { seq },
	};
}

async function collect<T>(gen: AsyncGenerator<T, void, void>, n: number): Promise<T[]> {
	const out: T[] = [];
	for await (const v of gen) {
		out.push(v);
		if (out.length >= n) break;
	}
	return out;
}

describe("RunEventBroker", () => {
	test("subscribe yields events that publish() pushes after subscription", async () => {
		const broker = new RunEventBroker();
		const sub = broker.subscribe("run_a");
		setTimeout(() => {
			broker.publish("run_a", makeEvent("run_a", 1));
			broker.publish("run_a", makeEvent("run_a", 2));
		}, 0);
		const got = await collect(sub, 2);
		expect(got.map((e) => e.sandboxEventSeq)).toEqual([1, 2]);
	});

	test("publish to a runId with no subscribers is a no-op", () => {
		const broker = new RunEventBroker();
		broker.publish("run_a", makeEvent("run_a", 1));
		expect(broker.subscriberCount("run_a")).toBe(0);
	});

	test("close() ends the subscriber generator after the buffer drains", async () => {
		const broker = new RunEventBroker();
		const sub = broker.subscribe("run_a");
		broker.publish("run_a", makeEvent("run_a", 1));
		broker.publish("run_a", makeEvent("run_a", 2));
		broker.close("run_a");
		const out: EventRow[] = [];
		for await (const ev of sub) out.push(ev);
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1, 2]);
		expect(broker.subscriberCount("run_a")).toBe(0);
	});

	test("multiple subscribers each receive every published event", async () => {
		const broker = new RunEventBroker();
		const a = broker.subscribe("run_a");
		const b = broker.subscribe("run_a");
		setTimeout(() => {
			broker.publish("run_a", makeEvent("run_a", 1));
			broker.publish("run_a", makeEvent("run_a", 2));
			broker.close("run_a");
		}, 0);
		const aOut: EventRow[] = [];
		const bOut: EventRow[] = [];
		for await (const ev of a) aOut.push(ev);
		for await (const ev of b) bOut.push(ev);
		expect(aOut.map((e) => e.sandboxEventSeq)).toEqual([1, 2]);
		expect(bOut.map((e) => e.sandboxEventSeq)).toEqual([1, 2]);
	});

	test("subscribers for different runIds are isolated", async () => {
		const broker = new RunEventBroker();
		const a = broker.subscribe("run_a");
		const b = broker.subscribe("run_b");
		setTimeout(() => {
			broker.publish("run_a", makeEvent("run_a", 1));
			broker.publish("run_b", makeEvent("run_b", 9));
			broker.close("run_a");
			broker.close("run_b");
		}, 0);
		const aOut: EventRow[] = [];
		const bOut: EventRow[] = [];
		for await (const ev of a) aOut.push(ev);
		for await (const ev of b) bOut.push(ev);
		expect(aOut.map((e) => e.sandboxEventSeq)).toEqual([1]);
		expect(bOut.map((e) => e.sandboxEventSeq)).toEqual([9]);
	});

	test("AbortSignal ends the subscriber generator and detaches", async () => {
		const broker = new RunEventBroker();
		const ctrl = new AbortController();
		const sub = broker.subscribe("run_a", { signal: ctrl.signal });
		broker.publish("run_a", makeEvent("run_a", 1));
		ctrl.abort();
		const out: EventRow[] = [];
		for await (const ev of sub) out.push(ev);
		// The buffered event is still yielded before the generator returns.
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1]);
		expect(broker.subscriberCount("run_a")).toBe(0);
	});

	test("subscriber that breaks out detaches from the broker", async () => {
		const broker = new RunEventBroker();
		const sub = broker.subscribe("run_a");
		broker.publish("run_a", makeEvent("run_a", 1));
		for await (const _ev of sub) {
			break;
		}
		expect(broker.subscriberCount("run_a")).toBe(0);
	});

	test("bufferSize cap drops the oldest queued event when exceeded", async () => {
		const broker = new RunEventBroker();
		const sub = broker.subscribe("run_a", { bufferSize: 2 });
		broker.publish("run_a", makeEvent("run_a", 1));
		broker.publish("run_a", makeEvent("run_a", 2));
		broker.publish("run_a", makeEvent("run_a", 3)); // drops seq=1
		broker.close("run_a");
		const out: EventRow[] = [];
		for await (const ev of sub) out.push(ev);
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([2, 3]);
	});
});

describe("tailRunEvents", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		runId = run.id;
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	async function appendRow(seq: number): Promise<EventRow> {
		return await repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: new Date(2026, 4, 8, 12, 0, seq).toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { seq },
		});
	}

	test("follow=false replays history then returns", async () => {
		await appendRow(1);
		await appendRow(2);
		await appendRow(3);
		const tail = tailRunEvents({ runId, repos, broker, follow: false });
		const out: EventRow[] = [];
		for await (const ev of tail) out.push(ev);
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1, 2, 3]);
	});

	test("follow=false respects sinceSeq", async () => {
		await appendRow(1);
		await appendRow(2);
		await appendRow(3);
		const tail = tailRunEvents({ runId, repos, broker, follow: false, sinceSeq: 1 });
		const out: EventRow[] = [];
		for await (const ev of tail) out.push(ev);
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([2, 3]);
	});

	test("follow=false bounds the snapshot to one page (warren-2a8b)", async () => {
		for (let seq = 1; seq <= 5; seq += 1) await appendRow(seq);
		const tail = tailRunEvents({ runId, repos, broker, follow: false, snapshotLimit: 2 });
		const out: EventRow[] = [];
		for await (const ev of tail) out.push(ev);
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1, 2]);
	});

	test("follow=false pages the full transcript via sinceSeq (warren-2a8b)", async () => {
		for (let seq = 1; seq <= 5; seq += 1) await appendRow(seq);
		const seen: number[] = [];
		let sinceSeq = 0;
		while (true) {
			const tail = tailRunEvents({
				runId,
				repos,
				broker,
				follow: false,
				sinceSeq,
				snapshotLimit: 2,
			});
			const page: EventRow[] = [];
			for await (const ev of tail) page.push(ev);
			if (page.length === 0) break;
			for (const ev of page) seen.push(ev.sandboxEventSeq);
			sinceSeq = page[page.length - 1]?.sandboxEventSeq ?? sinceSeq;
		}
		expect(seen).toEqual([1, 2, 3, 4, 5]);
	});

	test("follow=true pages through history in bounded chunks without truncating (warren-2a8b)", async () => {
		for (let seq = 1; seq <= 5; seq += 1) await appendRow(seq);
		const tail = tailRunEvents({ runId, repos, broker, follow: true, snapshotLimit: 2 });
		const out: EventRow[] = [];
		const done = (async () => {
			for await (const ev of tail) out.push(ev);
		})();
		await new Promise((r) => setTimeout(r, 20));
		broker.close(runId);
		await done;
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1, 2, 3, 4, 5]);
	});

	test("follow=true: history first, then live events, dedup at the seam", async () => {
		await appendRow(1);
		await appendRow(2);
		const ctrl = new AbortController();
		const tail = tailRunEvents({ runId, repos, broker, follow: true, signal: ctrl.signal });

		// Race: publish a duplicate of seq=2 (already in history) plus a fresh
		// seq=3 after the consumer has had a chance to start. The seam dedup
		// should drop the duplicate and emit the new one.
		const out: EventRow[] = [];
		const consumer = (async () => {
			for await (const ev of tail) {
				out.push(ev);
				if (out.length >= 3) ctrl.abort();
			}
		})();

		// Yield once so tailRunEvents subscribes + reads history.
		await new Promise((r) => setTimeout(r, 5));
		const dupRow = await appendRow(2); // simulated overlap (would never happen in real bridge)
		broker.publish(runId, dupRow);
		const freshRow = await appendRow(3);
		broker.publish(runId, freshRow);

		await consumer;
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1, 2, 3]);
	});

	test("follow=true subscribes BEFORE reading history (no gap drop)", async () => {
		// We don't have a real concurrency hook into events.listByRun, so we
		// drive the timing manually: publish a live event "between" the
		// snapshot and the live tail by appending after the subscribe but
		// before consuming. The dedup logic ensures the event appears
		// exactly once.
		await appendRow(1);
		const ctrl = new AbortController();
		const tail = tailRunEvents({ runId, repos, broker, follow: true, signal: ctrl.signal });
		const out: EventRow[] = [];
		const consumer = (async () => {
			for await (const ev of tail) {
				out.push(ev);
				if (out.length >= 2) ctrl.abort();
			}
		})();
		await new Promise((r) => setTimeout(r, 5));
		const row = await appendRow(2);
		broker.publish(runId, row);
		await consumer;
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1, 2]);
	});

	test("follow=true returns when broker.close() is called and history is exhausted", async () => {
		await appendRow(1);
		const tail = tailRunEvents({ runId, repos, broker, follow: true });
		const out: EventRow[] = [];
		const done = (async () => {
			for await (const ev of tail) out.push(ev);
		})();
		await new Promise((r) => setTimeout(r, 5));
		broker.close(runId);
		await done;
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1]);
	});

	test("terminal backstop ends a follow tail with no live bridge (warren-7bff)", async () => {
		await appendRow(1);
		let terminal = false;
		const tail = tailRunEvents({
			runId,
			repos,
			broker,
			follow: true,
			terminal: { isTerminal: async () => terminal, pollMs: 10 },
		});
		const out: EventRow[] = [];
		const done = (async () => {
			for await (const ev of tail) out.push(ev);
		})();
		await new Promise((r) => setTimeout(r, 20));
		// The run finishes with no bridge alive to `broker.close` — and its
		// final event was committed to the table but never published.
		await appendRow(2);
		terminal = true;
		await done;
		// The tail drained the never-published final event, then closed.
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1, 2]);
	});

	test("terminal backstop: transient probe failures keep the tail alive", async () => {
		await appendRow(1);
		let calls = 0;
		const tail = tailRunEvents({
			runId,
			repos,
			broker,
			follow: true,
			terminal: {
				isTerminal: async () => {
					calls += 1;
					if (calls < 3) throw new Error("db busy");
					return true;
				},
				pollMs: 10,
			},
		});
		const out: EventRow[] = [];
		for await (const ev of tail) out.push(ev);
		expect(out.map((e) => e.sandboxEventSeq)).toEqual([1]);
		expect(calls).toBeGreaterThanOrEqual(3);
	});
});

/**
 * Plan step 6 (warren-c8c3): the end-to-end smoke.
 *
 * A full fake-warren run lifecycle — dispatch, start, steer, branch push,
 * PR open, terminal — flows through the REAL pipeline (client → collector →
 * normalizer → audit store → export surface), including a kill-and-restart
 * mid-stream where an event is applied but never checkpointed. The replay
 * after restart must be an exact no-op, and the export must be byte-identical
 * to the committed golden at `__golden__/smoke-export.ndjson`.
 *
 * Determinism (plan risk 6): every `at` a row can carry is either a fixed
 * event `ts` from the fake or the injected clock — both are constants here.
 * Nothing post-processes the golden; regenerate an intentional shape change
 * with `AUDIT_LOG_UPDATE_GOLDENS=1 bun test src/smoke.test.ts`, then diff.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "./audit-store.ts";
import { createClient, type WarrenClient } from "./client.ts";
import { type EventSink, collectOnce } from "./collector.ts";
import { CursorStore } from "./cursor-store.ts";
import { FakeWarren } from "./fake-warren.ts";
import { AUDIT_EVENT_TYPES } from "./normalize.ts";
import { createFetchHandler } from "./server.ts";
import type { RunEvent } from "./wire.ts";

const GOLDEN_PATH = join(import.meta.dir, "__golden__", "smoke-export.ndjson");

const RUN_ID = "r-smoke-1";
const T_DISPATCHED = "2026-08-04T22:00:00.000Z";

/** Fixed event timestamps on the wire — the golden's `at` values. */
const TS = {
	started: "2026-08-04T22:00:05.000Z",
	steered: "2026-08-04T22:01:00.000Z",
	idle: "2026-08-04T22:02:00.000Z",
	reaped: "2026-08-04T22:05:00.000Z",
	prOpened: "2026-08-04T22:05:30.000Z",
} as const;

function event(
	seq: number,
	ts: string,
	kind: string,
	payload: unknown,
): Omit<RunEvent, "runId"> {
	return { id: seq, seq, ts, kind, stream: "system", payload };
}

/** The full lifecycle event stream, split around the kill point. */
const PRE_KILL_EVENTS = [
	event(1, TS.started, "message", { role: "agent", body: "run claimed, starting" }),
	event(2, TS.steered, "steer.sent", {
		messageId: "msg-1",
		priority: "normal",
		fromActor: "operator",
		body: "also update the changelog",
	}),
	event(3, TS.idle, "message", { role: "agent", body: "steer applied" }),
];
const POST_RESTART_EVENTS = [
	event(4, TS.reaped, "reap.completed", {
		state: "succeeded",
		branchPushed: true,
		commitsAhead: 2,
	}),
	event(5, TS.prOpened, "reap.pr_opened", {
		prUrl: "https://github.com/example/repo/pull/42",
		mode: "pr",
		branch: "warren/r-smoke-1",
		baseBranch: "main",
	}),
];

/**
 * Simulates a kill between apply and checkpoint: applies the event to the
 * real audit store, then throws before the collector can checkpoint. The
 * cursor stays behind, so the next boot replays the event — the exact
 * at-least-once gap the audit store's dedupe key exists to close.
 */
class KillAfterApply implements EventSink {
	constructor(
		private readonly inner: AuditStore,
		private readonly killOnSeq: number,
	) {}
	apply(e: RunEvent): void {
		this.inner.apply(e);
		if (e.seq === this.killOnSeq) {
			throw new Error(`SIGKILL between apply and checkpoint at seq ${e.seq}`);
		}
	}
	observeRun(run: Parameters<AuditStore["observeRun"]>[0]): void {
		this.inner.observeRun(run);
	}
}

describe("end-to-end smoke with golden export", () => {
	let fake: FakeWarren;
	let dir: string;
	let dbPath: string;
	let client: WarrenClient;
	const runErrors: Array<[string, unknown]> = [];

	beforeEach(() => {
		fake = new FakeWarren();
		fake.start();
		dir = mkdtempSync(join(tmpdir(), "audit-log-smoke-"));
		dbPath = join(dir, "audit.db");
		client = createClient({ baseUrl: fake.baseUrl, token: "smoke-token" });
		runErrors.length = 0;
	});

	afterEach(() => {
		fake.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	async function cycle(sink: EventSink, cursors: CursorStore): Promise<void> {
		await collectOnce({
			client,
			store: cursors,
			sink,
			now: () => new Date(T_DISPATCHED),
			onRunError: (runId, err) => runErrors.push([runId, err]),
		});
	}

	test("a full lifecycle survives a mid-stream kill and matches the golden byte-for-byte", async () => {
		// ── Cycle 1: dispatch. The run is queued with no events yet; the
		//    run.dispatched fact is synthesized from the list sighting. ──
		fake.addRun({ id: RUN_ID, state: "queued", startedAt: T_DISPATCHED });
		let sink = new AuditStore(dbPath, { now: () => new Date(T_DISPATCHED) });
		let cursors = new CursorStore(dbPath);
		await cycle(sink, cursors);
		expect(sink.all().map((r) => r.event)).toEqual(["run.dispatched"]);

		// ── Cycle 2: start + steer, then the kill. seq 3 is applied but
		//    never checkpointed; the cursor stops at seq 2. ──
		fake.setRunState(RUN_ID, "running");
		for (const e of PRE_KILL_EVENTS) fake.addEvent(RUN_ID, e);
		const killSink = new KillAfterApply(sink, 3);
		await cycle(killSink, cursors);
		expect(runErrors).toHaveLength(1);
		expect(String(runErrors[0]![1])).toContain("SIGKILL between apply and checkpoint");
		expect(cursors.get(RUN_ID).lastSeq).toBe(2);
		const rowsAtKill = sink.all();
		expect(rowsAtKill.map((r) => r.event)).toEqual([
			"run.dispatched",
			"run.started",
			"run.steered",
		]);

		// ── Kill: close both stores on the durable file. Restart: reopen
		//    them and finish the lifecycle (push, PR, terminal). ──
		sink.close();
		cursors.close();
		for (const e of POST_RESTART_EVENTS) fake.addEvent(RUN_ID, e);
		fake.setRunState(RUN_ID, "succeeded");

		sink = new AuditStore(dbPath, { now: () => new Date(T_DISPATCHED) });
		cursors = new CursorStore(dbPath);
		await cycle(sink, cursors);

		// The replay of un-checkpointed seq 3 was an exact no-op: no new row,
		// no consumed id, and the restart's row count picks up exactly where
		// the kill left off.
		expect(cursors.get(RUN_ID).lastSeq).toBe(5);
		expect(cursors.get(RUN_ID).drained).toBe(true);

		// ── Each of the six audit event types exactly once. ──
		const rows = sink.all();
		expect(rows).toHaveLength(AUDIT_EVENT_TYPES.length);
		for (const type of AUDIT_EVENT_TYPES) {
			expect(rows.filter((r) => r.event === type)).toHaveLength(1);
		}
		// Ids are contiguous from 1: the replayed fact consumed none.
		expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);

		// ── The export surface serves the golden, byte-for-byte. ──
		const handler = createFetchHandler({
			store: sink,
			cursors,
			health: {
				lastCycle: null,
				lastCycleAt: null,
				lastCycleError: null,
				startedAt: new Date(T_DISPATCHED),
			},
			extensionName: "audit-log",
			extensionVersion: "0.0.0",
		});
		const res = handler(new Request("http://export/audit-log.jsonl"));
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Audit-Log-Max-Id")).toBe("6");
		const body = await res.text();

		if (process.env.AUDIT_LOG_UPDATE_GOLDENS === "1") {
			await Bun.write(GOLDEN_PATH, body);
		}
		const golden = await Bun.file(GOLDEN_PATH).text();
		expect(body).toBe(golden);

		// ── Paging the export over the kill boundary shows no skips and no
		//    duplicates (acceptance 3): page in twos and reassemble. ──
		let since = 0;
		let paged = "";
		while (true) {
			const pageRes = handler(new Request(`http://export/audit-log.jsonl?since=${since}&limit=2`));
			const page = await pageRes.text();
			const lines = page.split("\n").filter((l) => l !== "");
			if (lines.length === 0) break;
			paged += page;
			// The next cursor is the last row's id; X-Audit-Log-Max-Id is the
			// global high-water mark for checkpointing EMPTY pages, not the
			// page cursor (server.ts).
			since = (JSON.parse(lines[lines.length - 1]!) as { id: number }).id;
		}
		expect(paged).toBe(body);

		sink.close();
		cursors.close();
	});

	test("the smoke's request profile documents the per-run tail fan-out cost", async () => {
		// One run, three poll cycles, mid-stream kill: every cycle pays a
		// full `GET /runs` re-list plus one bounded tail page per active run.
		// The numbers here are the citation in FRICTION §1 — change them only
		// by changing the collector's request pattern, then update FRICTION.
		fake.addRun({ id: RUN_ID, state: "queued", startedAt: T_DISPATCHED });
		const sink = new AuditStore(dbPath, { now: () => new Date(T_DISPATCHED) });
		const cursors = new CursorStore(dbPath);
		await cycle(sink, cursors);

		fake.setRunState(RUN_ID, "running");
		for (const e of PRE_KILL_EVENTS) fake.addEvent(RUN_ID, e);
		await cycle(sink, cursors);

		for (const e of POST_RESTART_EVENTS) fake.addEvent(RUN_ID, e);
		fake.setRunState(RUN_ID, "succeeded");
		await cycle(sink, cursors);

		// 3 cycles × (1 discovery list) + 3 tail pages (empty, 3 events, 2 events).
		expect(fake.requestCounts.get("GET /runs")).toBe(3);
		expect(fake.requestCounts.get("GET /runs/:id/events")).toBe(3);

		sink.close();
		cursors.close();
	});
});

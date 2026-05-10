/**
 * Scenario 05 — `GET /runs/:id/events` NDJSON tail + events-table durability.
 *
 * Acceptance criterion #5:
 *   "POST /runs/:id/events?follow=1 streams an NDJSON tail of run events;
 *   each row is an envelope `{ id, runId, seq, ts, kind, stream, payload }`;
 *   warren persists every observed event to the events table BEFORE
 *   publishing onto the broker (mx-e402e5), so a non-follow GET against
 *   the same run replays the identical sequence."
 *
 * Verifies:
 *
 *   1. The follow=1 generator yields envelope-shaped JSON rows. Every
 *      row references the spawned `runId` and carries a strictly
 *      increasing `seq`.
 *   2. A non-follow GET (history-only) replays the same events in the
 *      same order — proving the events-first/broker-after ordering and
 *      the table's durability across the bridge handoff.
 *   3. `?since=<seq>` drops every row at-or-below that seq. This is the
 *      "MAX(events.burrow_event_seq)+1" recovery primitive scenario 06
 *      depends on.
 *
 * Why not assert specific event counts: the stub agent emits ~3 setup
 * lines plus per-second heartbeat events while it sleeps (lib/stub-agent).
 * Burrow's raw-text parser turns each into a `text` event but doesn't
 * synthesise a state_change terminal — so warren's bridge never sees a
 * runtime-terminal signal for stub-shell. We cancel the run at the end
 * to drive teardown without waiting for the full sleep window.
 */

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
}

interface CreateRunResponse {
	readonly run: { readonly id: string; readonly state: string };
	readonly burrow: { readonly id: string };
}

interface EventEnvelope {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

const COLLECT_TIMEOUT_MS = 30_000;
const FIRST_EVENT_TIMEOUT_MS = 15_000;
const MIN_EVENTS = 3;

export const scenario: Scenario = {
	id: "05",
	title: "GET /runs/:id/events follows NDJSON; events durable in events table",
	modes: ["in-proc", "container"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-05 events tail",
			},
		});
		const runId = created.run.id;
		ctx.logger.debug(`scenario-05: spawned ${runId}`);

		try {
			// 1. follow=1 — collect MIN_EVENTS envelopes off the live stream,
			// then break. Breaking out of streamNdjson cancels the underlying
			// response, which is what we want — we don't need the rest of the
			// run's events here, scenario 06 covers the long-run case.
			const followCtrl = new AbortController();
			const watchdog = setTimeout(() => followCtrl.abort(), COLLECT_TIMEOUT_MS);
			const liveEvents: EventEnvelope[] = [];
			try {
				for await (const env of http.streamNdjson(
					`/runs/${encodeURIComponent(runId)}/events?follow=1`,
					followCtrl.signal,
				)) {
					liveEvents.push(env as EventEnvelope);
					if (liveEvents.length >= MIN_EVENTS) break;
				}
			} finally {
				clearTimeout(watchdog);
				followCtrl.abort();
			}
			assertTrue(
				liveEvents.length >= MIN_EVENTS,
				`follow=1 stream yielded ${liveEvents.length} events before close, expected ≥ ${MIN_EVENTS}`,
			);

			validateEnvelopeShape(liveEvents, runId);
			assertStrictlyIncreasing(
				liveEvents.map((e) => e.seq),
				"follow=1 seqs",
			);

			// Wait for the non-follow replay to catch up to at least the same
			// seq we saw on follow=1. The bridge writes to events FIRST then
			// broker.publish (mx-e402e5), so the moment we see a seq on the
			// follow stream the same row is already in the events table —
			// but we wrap a small retry to absorb scheduling jitter.
			const targetSeq = liveEvents[liveEvents.length - 1]?.seq ?? 0;
			const replay = await waitForReplayAtLeast(http, runId, targetSeq, FIRST_EVENT_TIMEOUT_MS);
			validateEnvelopeShape(replay, runId);
			assertStrictlyIncreasing(
				replay.map((e) => e.seq),
				"non-follow seqs",
			);

			// The replay must include every seq we saw on the live stream.
			const replaySeqs = new Set(replay.map((e) => e.seq));
			for (const env of liveEvents) {
				assertTrue(
					replaySeqs.has(env.seq),
					`non-follow replay missing seq ${env.seq} that follow=1 yielded`,
				);
			}

			// 3. ?since=<seq> drops everything at-or-below that seq.
			const midSeq = liveEvents[Math.floor(liveEvents.length / 2)]?.seq;
			if (midSeq === undefined) {
				throw new AcceptanceError("no mid-seq to test ?since= against");
			}
			const sinceCtrl = new AbortController();
			const sinceWatchdog = setTimeout(() => sinceCtrl.abort(), COLLECT_TIMEOUT_MS);
			const sinceEvents: EventEnvelope[] = [];
			try {
				for await (const env of http.streamNdjson(
					`/runs/${encodeURIComponent(runId)}/events?since=${midSeq}`,
					sinceCtrl.signal,
				)) {
					sinceEvents.push(env as EventEnvelope);
				}
			} finally {
				clearTimeout(sinceWatchdog);
			}
			for (const env of sinceEvents) {
				assertTrue(env.seq > midSeq, `since=${midSeq} must drop seq <= ${midSeq}, got ${env.seq}`);
			}

			// Negative path — unknown run id 404s before opening the stream.
			const notFound = await http.request("GET", "/runs/run_doesnotexist/events");
			assertEqual(notFound.status, 404, "GET /runs/<unknown>/events returns 404");
		} finally {
			// Cancel the run so teardown doesn't race the 8s heartbeat loop.
			// Cancel is idempotent; ignore failures (mx-fadaa2).
			await safelyCancel(http, runId, ctx);
		}
	},
};

function validateEnvelopeShape(events: readonly EventEnvelope[], runId: string): void {
	for (const env of events) {
		assertTrue(typeof env.id === "number", "event.id is a number");
		assertEqual(env.runId, runId, "event.runId matches the spawned run");
		assertTrue(typeof env.seq === "number" && env.seq >= 1, "event.seq >= 1");
		assertTrue(
			typeof env.ts === "string" && /^\d{4}-\d{2}-\d{2}T/.test(env.ts),
			`event.ts is ISO8601, got ${JSON.stringify(env.ts)}`,
		);
		assertTrue(typeof env.kind === "string" && env.kind.length > 0, "event.kind populated");
		// stream is nullable per the schema enum (mx-e7e5b5); shape check
		// only — no value check, since text events land on stdout but
		// broker-injected events may land on system.
		if (env.stream !== null) {
			assertTrue(typeof env.stream === "string", "event.stream is string|null");
		}
	}
}

function assertStrictlyIncreasing(seqs: readonly number[], label: string): void {
	for (let i = 1; i < seqs.length; i++) {
		const prev = seqs[i - 1] ?? 0;
		const cur = seqs[i] ?? 0;
		if (cur <= prev) {
			throw new AcceptanceError(
				`${label}: seqs must be strictly increasing, saw ${prev} → ${cur} at index ${i}`,
			);
		}
	}
}

async function waitForReplayAtLeast(
	http: WarrenHttp,
	runId: string,
	targetSeq: number,
	timeoutMs: number,
): Promise<readonly EventEnvelope[]> {
	const deadline = Date.now() + timeoutMs;
	let last: EventEnvelope[] = [];
	while (Date.now() < deadline) {
		last = await collectAll(http, `/runs/${encodeURIComponent(runId)}/events`);
		const max = last.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
		if (max >= targetSeq) return last;
		await sleep(100);
	}
	throw new AcceptanceError(
		`non-follow replay never reached seq ${targetSeq} within ${timeoutMs}ms (got ${last.length} events, max seq ${last.reduce((m, e) => (e.seq > m ? e.seq : m), 0)})`,
	);
}

async function collectAll(http: WarrenHttp, path: string): Promise<EventEnvelope[]> {
	const out: EventEnvelope[] = [];
	for await (const env of http.streamNdjson(path)) {
		out.push(env as EventEnvelope);
	}
	return out;
}

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	// Earlier scenarios may have already cloned this fixture and not torn it
	// down. We tolerate either state — the run-spawn path needs a project
	// row, not a fresh one.
	const existing = await http.expectJson<{ projects: (ProjectRow & { gitUrl: string })[] }>(
		"GET",
		"/projects",
		200,
	);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return { id: found.id };
	return await http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function safelyCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtx): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-05: cancel failed (${err instanceof Error ? err.message : String(err)}) — best-effort, continuing`,
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

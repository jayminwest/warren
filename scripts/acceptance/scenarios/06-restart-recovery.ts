/**
 * Scenario 06 — restart-recovery (SPEC §9 "MAX(seq)+1" contract).
 *
 * Acceptance criterion #6:
 *   "Killing warren mid-run and restarting it: the bridge resumes from
 *   `MAX(events.burrow_event_seq) + 1`, no event is dropped, and the
 *   final events table mirrors burrow's stream end-to-end with no
 *   gaps in seq."
 *
 * Wire summary (re-derived from src/runs/stream/bridge.ts + src/server/bridges.ts):
 *   - warren's bridge polls burrow's `/runs/:burrowRunId/stream` and writes
 *     each event to `events` table BEFORE publishing on the broker.
 *   - On warren restart, `bootBridges()` walks runs in {queued, running}
 *     with a non-null `burrow_run_id` and re-attaches a fresh bridge.
 *   - Each new bridge reads `EventsRepo.maxSeqForRun(runId)` and skips
 *     events with `seq <= maxSeq` (mx-a0cf07). burrow's stream replays
 *     from the start, so the dedup is client-side.
 *
 * Timing:
 *   The stub agent (lib/stub-agent/agent.sh) emits per-second heartbeats
 *   while it sleeps for `WARREN_STUB_SLEEP_MS` (8s, set in run.ts via
 *   bootInProc.extraEnv). That gives the bridge a steady source of new
 *   burrow events during the warren-down window — without them, the
 *   restart-recovery path is silently dormant (no new events to bridge,
 *   no contradiction even if recovery is broken).
 *
 * Lifecycle: requires `ctx.lifecycle.killWarren` / `restartWarren`.
 * In-proc only until the container launcher exposes equivalent hooks.
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
	readonly run: {
		readonly id: string;
		readonly state: string;
		readonly burrowId: string | null;
		readonly burrowRunId: string | null;
	};
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

const PRE_KILL_MIN_EVENTS = 3;
const PRE_KILL_TIMEOUT_MS = 15_000;
const KILL_WINDOW_MS = 2_000;
const POST_RESTART_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 200;

export const scenario: Scenario = {
	id: "06",
	title: "warren restart resumes the bridge from MAX(seq)+1; events table has no gaps",
	modes: ["in-proc"],
	async run(ctx) {
		const lifecycle = ctx.lifecycle;
		if (lifecycle === undefined) {
			throw new AcceptanceError(
				"scenario 06 requires ctx.lifecycle (killWarren/restartWarren) — harness boot did not wire it",
			);
		}

		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-06 restart recovery",
			},
		});
		const runId = created.run.id;
		assertTrue(
			typeof created.run.burrowRunId === "string" && created.run.burrowRunId !== null,
			"POST /runs must attach burrow_run_id by the 201 — bootBridges resume needs it",
		);
		ctx.logger.debug(`scenario-06: spawned ${runId} (burrow_run_id=${created.run.burrowRunId})`);

		try {
			// Phase 1 — wait for the bridge to land at least PRE_KILL_MIN_EVENTS
			// events into warren's events table. This proves the bridge is
			// actively attached pre-kill.
			const beforeKill = await waitForEventCount(
				http,
				runId,
				PRE_KILL_MIN_EVENTS,
				PRE_KILL_TIMEOUT_MS,
			);
			assertNoSeqGaps(beforeKill, "pre-kill event sequence");
			const maxSeqBeforeKill = beforeKill[beforeKill.length - 1]?.seq ?? 0;
			ctx.logger.debug(
				`scenario-06: pre-kill events=${beforeKill.length} maxSeq=${maxSeqBeforeKill}`,
			);

			// Phase 2 — kill warren. Burrow stays up; the agent keeps sleeping
			// + heartbeating; burrow's events table accumulates rows warren
			// can't see until restart.
			await lifecycle.killWarren();
			ctx.logger.debug(`scenario-06: warren killed; sleeping ${KILL_WINDOW_MS}ms`);
			await sleep(KILL_WINDOW_MS);

			// Phase 3 — restart warren. bootBridges() walks queued/running
			// runs, finds this one, attaches a fresh bridge.
			await lifecycle.restartWarren();
			ctx.logger.debug("scenario-06: warren restarted");

			// Phase 4 — wait for the resumed bridge to write at least one new
			// event (seq > maxSeqBeforeKill). Without this, recovery could
			// silently no-op and the test would still pass on cached history.
			const afterRestart = await waitForSeqAbove(
				http,
				runId,
				maxSeqBeforeKill,
				POST_RESTART_TIMEOUT_MS,
			);
			const maxSeqAfter = afterRestart[afterRestart.length - 1]?.seq ?? 0;
			assertTrue(
				maxSeqAfter > maxSeqBeforeKill,
				`expected resumed bridge to write seq > ${maxSeqBeforeKill}, got max ${maxSeqAfter}`,
			);
			ctx.logger.debug(
				`scenario-06: post-restart events=${afterRestart.length} maxSeq=${maxSeqAfter}`,
			);

			// Phase 5 — final assertions. The events table must contain a
			// contiguous run from seq 1..maxSeqAfter. No gaps means the
			// MAX(seq)+1 dedup didn't drop any event burrow streamed during
			// the warren-down window.
			assertNoSeqGaps(afterRestart, "post-restart event sequence");
			assertEqual(afterRestart[0]?.seq ?? 0, 1, "first event in table is seq=1");
			assertEqual(
				afterRestart[afterRestart.length - 1]?.seq ?? 0,
				maxSeqAfter,
				"final event's seq matches max",
			);

			// Every pre-kill seq must still be present after restart — the
			// bridge dedupes via maxSeq, it doesn't truncate the table.
			const allSeqs = new Set(afterRestart.map((e) => e.seq));
			for (const env of beforeKill) {
				assertTrue(allSeqs.has(env.seq), `post-restart events lost pre-kill seq ${env.seq}`);
			}

			// Run row's burrow_run_id is unchanged across the restart — we're
			// resuming the same burrow run, not re-spawning.
			const reread = await http.expectJson<{ burrowRunId: string | null }>(
				"GET",
				`/runs/${encodeURIComponent(runId)}`,
				200,
			);
			assertEqual(
				reread.burrowRunId,
				created.run.burrowRunId,
				"GET /runs/:id post-restart preserves burrow_run_id",
			);
		} finally {
			await safelyCancel(http, runId, ctx);
		}
	},
};

async function waitForEventCount(
	http: WarrenHttp,
	runId: string,
	target: number,
	timeoutMs: number,
): Promise<readonly EventEnvelope[]> {
	const deadline = Date.now() + timeoutMs;
	let last: EventEnvelope[] = [];
	while (Date.now() < deadline) {
		last = await collectAll(http, `/runs/${encodeURIComponent(runId)}/events`);
		if (last.length >= target) return last;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`waited ${timeoutMs}ms for ${target} events on ${runId}, only saw ${last.length}`,
	);
}

async function waitForSeqAbove(
	http: WarrenHttp,
	runId: string,
	threshold: number,
	timeoutMs: number,
): Promise<readonly EventEnvelope[]> {
	const deadline = Date.now() + timeoutMs;
	let last: EventEnvelope[] = [];
	while (Date.now() < deadline) {
		last = await collectAll(http, `/runs/${encodeURIComponent(runId)}/events`);
		const max = last.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
		if (max > threshold) return last;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`waited ${timeoutMs}ms for seq > ${threshold} on ${runId}, saw max ${last.reduce((m, e) => (e.seq > m ? e.seq : m), 0)} (events=${last.length})`,
	);
}

async function collectAll(http: WarrenHttp, path: string): Promise<EventEnvelope[]> {
	const out: EventEnvelope[] = [];
	for await (const env of http.streamNdjson(path)) {
		out.push(env as EventEnvelope);
	}
	return out;
}

function assertNoSeqGaps(events: readonly EventEnvelope[], label: string): void {
	if (events.length === 0) {
		throw new AcceptanceError(`${label}: empty event list`);
	}
	const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
	for (let i = 1; i < seqs.length; i++) {
		const prev = seqs[i - 1] ?? 0;
		const cur = seqs[i] ?? 0;
		if (cur !== prev + 1) {
			throw new AcceptanceError(
				`${label}: gap in seq numbers ${prev} → ${cur} at index ${i} (full seqs=${JSON.stringify(seqs)})`,
			);
		}
	}
}

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	// Earlier scenarios may have left a project clone in place; tolerate
	// either state — the spawn path doesn't care whether it's a fresh row.
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
			`scenario-06: cancel failed (${err instanceof Error ? err.message : String(err)}) — best-effort, continuing`,
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

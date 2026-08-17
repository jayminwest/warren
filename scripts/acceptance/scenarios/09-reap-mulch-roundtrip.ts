/**
 * Scenario 09 — reap mulch roundtrip (docs/design/runtime-and-supervisor.md).
 *
 * Acceptance criterion #9:
 *   "On run terminal, warren copies the burrow's per-run
 *   `.mulch/expertise/*.jsonl` back into the project's persistent
 *   `.mulch/` with last-write-wins by record `recorded_at`. Three event
 *   shapes are observable on /runs/:id/events: `mulch.record.added` for
 *   a fresh id, `mulch.record.updated` when the incoming ts beats the
 *   project's existing ts, and `mulch.record.skipped` when the incoming
 *   ts is older-or-equal."
 *
 * The stub agent (scripts/acceptance/lib/stub-agent/
 * claude-code-path-shim.sh, installed as the `claude` binary the
 * internalized local engine execs — warren-dc19) honors
 * `[mulch_id=...]` and `[mulch_ts=...]` knobs in its prompt, so we can
 * drive all three LWW branches from a single warren boot without
 * restarting anything. Each run completes naturally after a brief
 * `[sleep_ms=1500]` (the shim writes its mulch record before the
 * sleep): under the internalized engine a mid-flight cancel settles on
 * the watchdog's 30s reconcile tick, far past any scenario budget,
 * while a natural completion reaps inline on the same code path.
 *
 * warren-dcf3 caveat: the harness's git-config insteadOf rewrites point
 * pushes at the local non-bare fixture repo, which rejects pushes to a
 * checked-out branch. Reap's branch_push step emits `reap_failed`
 * (step=branch_push) — we tolerate that and assert only the .mulch
 * roundtrip plus the mulch.* events. The seed (warren-c37e) explicitly
 * authorizes this scope cut.
 *
 * The three runs share a stable mulch id so the project's expertise
 * file is the LWW state machine across runs:
 *
 *   Run A: id=mx-acceptance-09 ts=2026-05-09T12:00:00.000Z
 *          → project file empty → `mulch.record.added` + appended=1.
 *
 *   Run B: same id, ts=2026-05-09T13:00:00.000Z (newer)
 *          → existing ts < incoming → `mulch.record.updated` +
 *            updated=1; project file's recorded_at advances to 13:00.
 *
 *   Run C: same id, ts=2026-05-09T11:00:00.000Z (older than Run B's)
 *          → existing ts > incoming → `mulch.record.skipped` +
 *            skipped=1; project file unchanged from Run B.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { waitForRunTerminal } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly addedAt: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly sandboxId: string | null;
	readonly sandboxRunId: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
}

const MULCH_DOMAIN = "acceptance";
const MULCH_ID = "mx-acceptance-09";
const TS_BASELINE = "2026-05-09T12:00:00.000Z";
const TS_NEWER = "2026-05-09T13:00:00.000Z";
const TS_OLDER = "2026-05-09T11:00:00.000Z";

export const scenario: Scenario = {
	id: "09",
	title:
		"Reap mulch roundtrip — LWW added/updated/skipped events; project .mulch/expertise advances",
	// Reap mulch requires a spawned run + host-side project fixture so
	// the harness can poke the on-disk .mulch/. In-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// The stub agent was seeded at boot via WARREN_SEED_AGENTS_FILE
		// (warren-e376); POST /agents/refresh is deleted (pl-3a79). GET it
		// to prove boot seeding landed before spawning against it.
		await http.expectStatus(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
		);
		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);
		const projectMulchFile = join(
			project.localPath,
			".mulch",
			"expertise",
			`${MULCH_DOMAIN}.jsonl`,
		);

		// Run A — fresh id; project's .mulch/expertise/<domain>.jsonl
		// either doesn't exist or doesn't carry MULCH_ID yet → reap
		// appends and emits `mulch.record.added`.
		const runA = await runStubAndReap(http, project.id, ctx.fixtures.stubAgentName, [
			`[mulch_id=${MULCH_ID}]`,
			`[mulch_ts=${TS_BASELINE}]`,
		]);
		const eventsA = await fetchAllEvents(http, runA.id);

		const addedEvent = findMulchEvent(eventsA, "mulch.record.added", MULCH_ID);
		if (addedEvent === undefined) {
			// Sibling scenarios may have already populated the same domain
			// file with a different id. The roundtrip itself still works —
			// look for `mulch.record.updated` as a fallback when MULCH_ID
			// happens to already exist (e.g. on a re-run against a kept
			// tmp dir). Fall through to the per-event-shape assertions.
			const fallback = findMulchEvent(eventsA, "mulch.record.updated", MULCH_ID);
			if (fallback === undefined) {
				throw new AcceptanceError(
					`Run A: expected mulch.record.added (or .updated) for id=${MULCH_ID} on /runs/${runA.id}/events; got kinds: ${summariseKinds(eventsA)}`,
				);
			}
			assertEqual(fallback.stream, "system", "Run A mulch event uses stream='system'");
		} else {
			assertEqual(
				addedEvent.payload?.id,
				MULCH_ID,
				"Run A mulch.record.added payload.id matches the prompt-driven mulch_id",
			);
			assertEqual(
				addedEvent.payload?.domain,
				MULCH_DOMAIN,
				"Run A mulch.record.added payload.domain matches the stub default domain",
			);
			assertEqual(
				addedEvent.stream,
				"system",
				"Run A mulch.record.added uses stream='system' (mx-e7e5b5)",
			);
		}

		const reapA = findReapCompleted(eventsA);
		const mulchA = readMulchSummary(reapA);
		assertTrue(
			mulchA.appended + mulchA.updated >= 1,
			`Run A: reap.completed mulch summary should report at least one appended/updated record; got ${JSON.stringify(mulchA)}`,
		);

		// Disk verification — project's .mulch/expertise/<domain>.jsonl
		// now carries the baseline ts for MULCH_ID. (Other scenarios may
		// also have written to this file; we only assert MULCH_ID's
		// recorded_at.)
		await assertProjectMulchHasTs(projectMulchFile, MULCH_ID, TS_BASELINE);

		// Run B — same id, newer ts → reap finds the existing record
		// and overwrites it; emits `mulch.record.updated`.
		const runB = await runStubAndReap(http, project.id, ctx.fixtures.stubAgentName, [
			`[mulch_id=${MULCH_ID}]`,
			`[mulch_ts=${TS_NEWER}]`,
		]);
		const eventsB = await fetchAllEvents(http, runB.id);

		const updatedEvent = findMulchEvent(eventsB, "mulch.record.updated", MULCH_ID);
		if (updatedEvent === undefined) {
			throw new AcceptanceError(
				`Run B: expected mulch.record.updated for id=${MULCH_ID} on /runs/${runB.id}/events; got kinds: ${summariseKinds(eventsB)}`,
			);
		}
		assertEqual(
			updatedEvent.payload?.previousRecordedAt,
			TS_BASELINE,
			"Run B mulch.record.updated previousRecordedAt is the Run A ts",
		);
		assertEqual(
			updatedEvent.payload?.newRecordedAt,
			TS_NEWER,
			"Run B mulch.record.updated newRecordedAt is the Run B ts",
		);
		assertEqual(updatedEvent.stream, "system", "Run B mulch.record.updated uses stream='system'");

		const reapB = findReapCompleted(eventsB);
		const mulchB = readMulchSummary(reapB);
		assertTrue(
			mulchB.updated >= 1,
			`Run B: reap.completed mulch.updated should be >= 1; got ${JSON.stringify(mulchB)}`,
		);

		await assertProjectMulchHasTs(projectMulchFile, MULCH_ID, TS_NEWER);

		// Run C — same id, older ts → reap drops the incoming and emits
		// `mulch.record.skipped`. The project file is unchanged from
		// Run B (still TS_NEWER).
		const runC = await runStubAndReap(http, project.id, ctx.fixtures.stubAgentName, [
			`[mulch_id=${MULCH_ID}]`,
			`[mulch_ts=${TS_OLDER}]`,
		]);
		const eventsC = await fetchAllEvents(http, runC.id);

		const skippedEvent = findMulchEvent(eventsC, "mulch.record.skipped", MULCH_ID);
		if (skippedEvent === undefined) {
			throw new AcceptanceError(
				`Run C: expected mulch.record.skipped for id=${MULCH_ID} on /runs/${runC.id}/events; got kinds: ${summariseKinds(eventsC)}`,
			);
		}
		assertEqual(
			skippedEvent.payload?.incomingRecordedAt,
			TS_OLDER,
			"Run C mulch.record.skipped incomingRecordedAt is the Run C ts",
		);
		assertEqual(
			skippedEvent.payload?.existingRecordedAt,
			TS_NEWER,
			"Run C mulch.record.skipped existingRecordedAt is the post-Run-B ts",
		);
		assertEqual(skippedEvent.stream, "system", "Run C mulch.record.skipped uses stream='system'");

		const reapC = findReapCompleted(eventsC);
		const mulchC = readMulchSummary(reapC);
		assertTrue(
			mulchC.skipped >= 1,
			`Run C: reap.completed mulch.skipped should be >= 1; got ${JSON.stringify(mulchC)}`,
		);

		// Disk: still TS_NEWER — skip means the file did not advance.
		await assertProjectMulchHasTs(projectMulchFile, MULCH_ID, TS_NEWER);
	},
};

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

/**
 * Spawn a stub run, wait for it to be observed in `running` (so reap
 * doesn't classify a queued-never-started failure per warren-3c40),
 * then cancel — burrow returns terminal state, warren reaps inline
 * (mx-bade10), and the run row finalizes to `cancelled`.
 *
 * The stub's mulch + seed writes happen before any sleep, so reap
 * captures them regardless of when we cancel.
 */
async function runStubAndReap(
	http: WarrenHttp,
	projectId: string,
	agentName: string,
	promptKnobs: readonly string[],
): Promise<RunRow> {
	// warren-dc19: no mid-flight cancel. Under the internalized local
	// engine the cancel → store-terminalize → watchdog reconcile path
	// settles on the watchdog's 30s tick, far past any scenario budget;
	// a short natural completion reaps inline on the same code path and
	// exercises the identical LWW mirror. The shim (claude-code-path-shim)
	// writes its mulch/seeds side effects before the sleep, so the brief
	// `[sleep_ms=1500]` only exists to prove the run goes through a real
	// running phase.
	const prompt = `[sleep_ms=1500] ${promptKnobs.join(" ")} scenario-09 reap roundtrip`.trim();
	const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
		body: { agent: agentName, project: projectId, prompt },
	});
	const run = created.run;
	assertTrue(
		typeof run.sandboxRunId === "string" &&
			run.sandboxRunId !== null &&
			run.sandboxRunId.length > 0,
		"spawn response missing sandboxRunId — reap path needs the burrow run id",
	);

	const finalState = await waitForTerminal(http, run.id, 30_000);
	assertEqual(
		finalState,
		"succeeded",
		`run ${run.id} should succeed under the claude path-shim; ended at '${finalState}'`,
	);
	return { ...run, state: finalState };
}

async function waitForTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<string> {
	return (await waitForRunTerminal(http, runId, timeoutMs)).state;
}

async function fetchAllEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

function findMulchEvent(
	events: readonly EventRow[],
	kind: "mulch.record.added" | "mulch.record.updated" | "mulch.record.skipped",
	id: string,
): EventRow | undefined {
	return events.find((e) => e.kind === kind && (e.payload?.id ?? null) === id);
}

function findReapCompleted(events: readonly EventRow[]): EventRow {
	const found = events.find((e) => e.kind === "reap.completed");
	if (found === undefined) {
		throw new AcceptanceError(
			`no reap.completed event on run; got kinds: ${summariseKinds(events)}`,
		);
	}
	return found;
}

interface MulchSummary {
	updated: number;
	skipped: number;
	appended: number;
}

function readMulchSummary(reap: EventRow): MulchSummary {
	const payload = reap.payload ?? {};
	const mulch = (payload.mulch ?? {}) as Record<string, unknown>;
	const updated = typeof mulch.updated === "number" ? mulch.updated : 0;
	const skipped = typeof mulch.skipped === "number" ? mulch.skipped : 0;
	const appended = typeof mulch.appended === "number" ? mulch.appended : 0;
	return { updated, skipped, appended };
}

async function assertProjectMulchHasTs(
	projectMulchFile: string,
	id: string,
	expectedTs: string,
): Promise<void> {
	let body: string;
	try {
		body = await readFile(projectMulchFile, "utf8");
	} catch (err) {
		throw new AcceptanceError(
			`project mulch file ${projectMulchFile} unreadable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const records = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	let last: { recorded_at?: string } | undefined;
	for (const line of records) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.id === id) last = parsed as { recorded_at?: string };
		} catch {
			// Skip unparseable lines — reap preserves them by design (mx-32631d
			// adjacent: never lose data the user wrote).
		}
	}
	if (last === undefined) {
		throw new AcceptanceError(
			`project mulch file ${projectMulchFile} does not contain id=${id} after reap`,
		);
	}
	assertEqual(last.recorded_at, expectedTs, `project mulch record id=${id} recorded_at after reap`);
}

function summariseKinds(events: readonly EventRow[]): string {
	const counts = new Map<string, number>();
	for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
	return Array.from(counts.entries())
		.map(([k, n]) => `${k}×${n}`)
		.join(", ");
}

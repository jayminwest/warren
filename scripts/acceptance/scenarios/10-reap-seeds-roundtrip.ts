/**
 * Scenario 10 — reap seeds-close roundtrip (docs/design/runtime-and-supervisor.md).
 *
 * Acceptance criterion #10:
 *   "Seeds the agent marks closed in the burrow's per-run `.seeds/`
 *   land in the project's persistent `.seeds/issues.jsonl` with the
 *   close mirrored. /runs/:id/events surfaces a `seeds.closed` event
 *   per mirrored row; reap.completed payload reports the count."
 *
 * The stub agent (scripts/acceptance/lib/stub-agent/agent.sh) honors
 * `[seed_id=...]` and `[seed_ts=...]` knobs so we can drive a fresh
 * close-mirror through reap on demand. The single happy path
 * exercised here:
 *
 *   Run: id=ah-acceptance-10 status=closed ts=2026-05-09T12:00:00.000Z
 *        → fresh id in project's `.seeds/issues.jsonl` → mode='added';
 *          reap.completed payload reports seeds.closed=1; the row
 *          materialises on disk in the project clone with status=closed
 *          and updatedAt=TS_BASELINE.
 *
 * Why only one run instead of also covering mode='updated':
 * `.seeds/issues.jsonl` is a tracked file in the fixture project, so
 * `spawnRun`'s pre-spawn `refreshProjectClone` (mx-6e85b9: `git
 * checkout --force` + `git reset --hard origin/<ref>`) wipes reap's
 * uncommitted writes between spawns. The 'updated' branch of
 * mirrorClosedSeeds is exercised by `src/runs/reap.test.ts` against a
 * controlled disk surface; this end-to-end scenario only certifies
 * the wiring. Filed as a follow-up if cross-run seeds persistence
 * becomes V1 territory.
 *
 * Mulch's `acceptance.jsonl` survives the refresh because it's not
 * tracked in the fixture (only `.mulch/.gitkeep` is committed), which
 * is why scenario 09 *can* exercise all three LWW branches.
 *
 * warren-3c40: poll for state=running before cancel so reap doesn't
 * misclassify as `never_started`.
 *
 * warren-dcf3: branch_push will fail against the non-bare local
 * fixture; reap_failed (step=branch_push) is tolerated. Seed
 * (warren-c37e) explicitly authorizes scoping the assertions to the
 * .seeds roundtrip.
 *
 * Note: reap's seeds-close mirror only mirrors closed seeds (not other
 * mutations); the "agent marked done" wording in docs/design/agent-composition.md maps
 * directly to that. Other seed mutations would ride on the workspace
 * branch push, which we don't assert here.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

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
	readonly burrowId: string | null;
	readonly burrowRunId: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

interface CancelResponse {
	readonly state: string;
	readonly alreadyTerminal: boolean;
	readonly burrowRun: { readonly state: string } | null;
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

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const SEED_ID = "ah-acceptance-10";
const TS_BASELINE = "2026-05-09T12:00:00.000Z";

export const scenario: Scenario = {
	id: "10",
	title:
		"Reap seeds-close roundtrip — closed seeds land in project .seeds/; seeds.closed events visible",
	// Reap seeds requires a spawned run + host-side project fixture so
	// the harness can poke the on-disk .seeds/. In-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);
		const projectSeedsFile = join(project.localPath, ".seeds", "issues.jsonl");

		// Pre-state: SEED_ID is fresh (other scenarios use stub-seed-1 /
		// ah-stub-1). assertSeedRow returns null if the row is absent.
		const pre = await readSeedRow(projectSeedsFile, SEED_ID);
		if (pre !== null) {
			throw new AcceptanceError(
				`scenario-10 expects ${SEED_ID} to be absent from project .seeds before the test; found ${JSON.stringify(pre)} — sibling scenario contaminated the fixture`,
			);
		}

		// Run A — fresh id, project doesn't carry it → mode='added'.
		const runA = await runStubAndReap(http, project.id, ctx.fixtures.stubAgentName, [
			`[seed_id=${SEED_ID}]`,
			`[seed_ts=${TS_BASELINE}]`,
		]);
		const eventsA = await fetchAllEvents(http, runA.id);
		const seedsAddedEvent = findSeedsClosedEvent(eventsA, SEED_ID);
		if (seedsAddedEvent === undefined) {
			throw new AcceptanceError(
				`Run A: expected seeds.closed event for id=${SEED_ID}; got kinds: ${summariseKinds(eventsA)}`,
			);
		}
		assertEqual(
			seedsAddedEvent.payload?.mode,
			"added",
			"Run A seeds.closed payload.mode is 'added' for a fresh seed id",
		);
		assertEqual(
			seedsAddedEvent.stream,
			"system",
			"Run A seeds.closed uses stream='system' (mx-e7e5b5)",
		);

		const reapA = findReapCompleted(eventsA);
		const seedsCountA = readSeedsCount(reapA);
		assertTrue(
			seedsCountA >= 1,
			`Run A: reap.completed seeds.closed count should be >= 1; got ${seedsCountA}`,
		);

		// Disk verification — the project's .seeds/issues.jsonl now
		// carries SEED_ID with status=closed and updatedAt=TS_BASELINE.
		await assertProjectSeedClosed(projectSeedsFile, SEED_ID, TS_BASELINE);
	},
};

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function runStubAndReap(
	http: WarrenHttp,
	projectId: string,
	agentName: string,
	promptKnobs: readonly string[],
): Promise<RunRow> {
	const prompt = `[sleep_ms=4000] ${promptKnobs.join(" ")} scenario-10 seeds roundtrip`.trim();
	const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
		body: { agent: agentName, project: projectId, prompt },
	});
	const run = created.run;
	assertTrue(
		typeof run.burrowRunId === "string" && run.burrowRunId !== null && run.burrowRunId.length > 0,
		"spawn response missing burrowRunId",
	);
	await waitForRunning(http, run.id, 5_000);
	const cancelRes = await http.expectJson<CancelResponse>(
		"POST",
		`/runs/${encodeURIComponent(run.id)}/cancel`,
		200,
		{ body: { reason: "scenario-10 seeds roundtrip" } },
	);
	assertEqual(
		cancelRes.alreadyTerminal,
		false,
		"reap-roundtrip cancel should not report alreadyTerminal=true",
	);
	const finalState = await waitForTerminal(http, run.id, 8_000);
	assertTrue(
		TERMINAL_STATES.has(finalState),
		`run ${run.id} did not reach a terminal state; ended at '${finalState}'`,
	);
	return { ...run, state: finalState };
}

async function waitForRunning(http: WarrenHttp, runId: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (row.state === "running") return;
		if (TERMINAL_STATES.has(row.state)) {
			throw new AcceptanceError(
				`run ${runId} reached terminal state '${row.state}' before bridge mirrored running — reap will misclassify (warren-3c40 territory)`,
			);
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach 'running' within ${timeoutMs}ms (last state=${last})`,
	);
}

async function waitForTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<string> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (TERMINAL_STATES.has(row.state)) return row.state;
		await sleep(100);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach a terminal state within ${timeoutMs}ms (last state=${last})`,
	);
}

async function fetchAllEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

function findSeedsClosedEvent(events: readonly EventRow[], id: string): EventRow | undefined {
	return events.find((e) => e.kind === "seeds.closed" && (e.payload?.id ?? null) === id);
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

function readSeedsCount(reap: EventRow): number {
	const payload = reap.payload ?? {};
	const seeds = (payload.seeds ?? {}) as Record<string, unknown>;
	return typeof seeds.closed === "number" ? seeds.closed : 0;
}

interface SeedRow {
	id: string;
	status: string;
	updatedAt: string;
}

async function readSeedRow(projectSeedsFile: string, id: string): Promise<SeedRow | null> {
	let body: string;
	try {
		body = await readFile(projectSeedsFile, "utf8");
	} catch (err) {
		if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") {
			return null;
		}
		throw new AcceptanceError(
			`project seeds file ${projectSeedsFile} unreadable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let last: SeedRow | null = null;
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (parsed.id !== id) continue;
			const status = typeof parsed.status === "string" ? parsed.status : "";
			const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
			last = { id, status, updatedAt };
		} catch {
			// preserve unparseable lines (reap-side parity); skip for our read.
		}
	}
	return last;
}

async function assertProjectSeedClosed(
	projectSeedsFile: string,
	id: string,
	expectedUpdatedAt: string,
): Promise<void> {
	const row = await readSeedRow(projectSeedsFile, id);
	if (row === null) {
		throw new AcceptanceError(
			`project seeds file ${projectSeedsFile} does not contain id=${id} after reap`,
		);
	}
	assertEqual(row.status, "closed", `project seed id=${id} status after reap`);
	assertEqual(row.updatedAt, expectedUpdatedAt, `project seed id=${id} updatedAt after reap`);
}

function summariseKinds(events: readonly EventRow[]): string {
	const counts = new Map<string, number>();
	for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
	return Array.from(counts.entries())
		.map(([k, n]) => `${k}×${n}`)
		.join(", ");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

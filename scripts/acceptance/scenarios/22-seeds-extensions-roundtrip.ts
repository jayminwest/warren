/**
 * Scenario 22 — seeds-extensions-roundtrip (R-01, pl-bb70 step 7).
 *
 * Acceptance criteria #3, #5, #6 of pl-bb70:
 *   3. After a manual POST /runs with seedId, `sd show <seed> --format json`
 *      shows extensions.{role,trigger:'manual',lastRunId,lastRunAt}.
 *   5. Extension write failure emits a `seeds_extension_write_failed` system
 *      event on the run and does NOT abort the run (verified by injecting a
 *      bogus seedId that `sd update` rejects).
 *   6. RunDetail/Run API surfaces a seed back-link via runs.seedId.
 *
 * The cron-tick consolidation (#4) is already exercised end-to-end by
 * scenario 15, which asserts {scheduledFor:null, lastScheduledRun, role,
 * trigger:'scheduled', lastRunId, lastRunAt} land in a single sd update
 * after the scheduler dispatches a past-due seed. This scenario focuses on
 * the manual dispatch path so the producer-side contract is covered end to
 * end across both triggers.
 *
 * Layout mirrors scenario 15: bootstrap `.seeds/config.yaml` in the source
 * repo if missing, append a known seed, commit, refresh. spawnRun does its
 * own `git reset --hard` on the project clone before dispatch (mx-6e85b9),
 * so the only durable surface this scenario reads is the project clone's
 * `.seeds/issues.jsonl` *after* warren has already shelled out to
 * `sd update --extensions`.
 *
 * Idempotent cleanup: any seed rows this scenario appends to the source
 * repo are stripped at the end, matching scenario 15's reset posture so a
 * re-run lands the harness back in baseline state.
 */

import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly trigger: string;
	readonly agentName: string;
	readonly projectId: string | null;
	readonly seedId: string | null;
	readonly burrowId: string | null;
	readonly burrowRunId: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

interface RefreshResponse {
	readonly project: ProjectRow;
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

const TARGET_SEED_ID = "ah-acceptance-22-target";
const BOGUS_SEED_ID = "ah-acceptance-22-bogus";
const SEED_CREATED_AT = "2026-05-08T00:00:00.000Z";
// ISO 8601 with millisecond precision, matches `new Date().toISOString()`.
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

export const scenario: Scenario = {
	id: "22",
	title:
		"Seeds extensions roundtrip — manual POST /runs stamps {role,trigger,lastRunId,lastRunAt}; bogus seed surfaces seeds_extension_write_failed",
	// Drives source-repo edits the container harness doesn't bind-mount
	// (mirrors scenario 14/15 rationale). In-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);

		// Reset in case a prior scenario (or a previous pass of this one)
		// left rows behind; same idempotency posture as scenario 15.
		await resetSourceState(ctx.fixtures.sampleProjectPath);
		await refreshProject(http, project.id);

		// ----------------------------------------------------------------
		// Bootstrap `.seeds/config.yaml` (required by `sd update`) and
		// append the target seed row, then commit + refresh so the project
		// clone has the seed when spawnRun's post-dispatch update fires.
		// ----------------------------------------------------------------
		const seedsDir = join(ctx.fixtures.sampleProjectPath, ".seeds");
		const seedsConfig = join(seedsDir, "config.yaml");
		if (!existsSync(seedsConfig)) {
			await writeFile(
				seedsConfig,
				`project: "${ctx.fixtures.sampleProjectName}"\nversion: "1"\nmax_plan_depth: 3\n`,
			);
		}
		await appendFile(join(seedsDir, "issues.jsonl"), seedRow(TARGET_SEED_ID));
		await commitInSource(
			ctx.fixtures.sampleProjectPath,
			`scenario-22: add ${TARGET_SEED_ID} + .seeds/config.yaml`,
		);
		await refreshProject(http, project.id);

		// ----------------------------------------------------------------
		// Happy path — POST /runs with the real seedId. spawnRun shells
		// out to `sd update <id> --extensions <json>` after dispatch
		// (writeSeedExtensions, src/runs/spawn/seed-extensions.ts) and the 201 only lands
		// once that returns, so disk state is observable as soon as the
		// response resolves.
		// ----------------------------------------------------------------
		const happy = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "[sleep_ms=8000] scenario-22 seeds-extensions happy path",
				seedId: TARGET_SEED_ID,
			},
		});
		assertEqual(
			happy.run.seedId,
			TARGET_SEED_ID,
			"POST /runs: response.run.seedId echoes the request payload (pl-bb70 step 6)",
		);
		assertEqual(
			happy.run.trigger,
			"manual",
			"POST /runs: default trigger is 'manual' (writeSeedExtensions input)",
		);

		const reread = await http.expectJson<RunRow>(
			"GET",
			`/runs/${encodeURIComponent(happy.run.id)}`,
			200,
		);
		assertEqual(
			reread.seedId,
			TARGET_SEED_ID,
			"GET /runs/:id: seedId surfaces on the Run JSON shape so the UI back-link can render",
		);

		// Disk assertion — the project clone's .seeds/issues.jsonl now
		// carries `extensions.{role,trigger:'manual',lastRunId,lastRunAt}`
		// on the target seed.
		const seedsFile = join(project.localPath, ".seeds", "issues.jsonl");
		const happyRow = await requireSeedRow(seedsFile, TARGET_SEED_ID);
		const happyExt = happyRow.extensions ?? {};
		assertEqual(
			happyExt.role,
			ctx.fixtures.stubAgentName,
			"target seed: extensions.role records the dispatched agent",
		);
		assertEqual(
			happyExt.trigger,
			"manual",
			"target seed: extensions.trigger is 'manual' for POST /runs",
		);
		assertEqual(
			happyExt.lastRunId,
			happy.run.id,
			"target seed: extensions.lastRunId records the warren run id",
		);
		assertTrue(
			typeof happyExt.lastRunAt === "string" && ISO_PATTERN.test(happyExt.lastRunAt),
			`target seed: extensions.lastRunAt is an ISO 8601 timestamp; got ${JSON.stringify(happyExt.lastRunAt)}`,
		);

		// Cancel so teardown doesn't race the 8s stub sleep.
		await cancelAndDrain(http, happy.run.id);

		// ----------------------------------------------------------------
		// Failure path — POST /runs with a seedId that does NOT exist in
		// .seeds/issues.jsonl. `sd update` exits non-zero;
		// writeSeedExtensions swallows the failure, emits a
		// `seeds_extension_write_failed` system event, and the run still
		// reaches a terminal state cleanly (no rollback over a logging
		// failure — see src/runs/spawn/seed-extensions.ts:writeSeedExtensions).
		// ----------------------------------------------------------------
		const failing = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "[sleep_ms=8000] scenario-22 seeds-extensions failure path",
				seedId: BOGUS_SEED_ID,
			},
		});
		assertEqual(
			failing.run.seedId,
			BOGUS_SEED_ID,
			"POST /runs (bogus seed): seedId persists on the row regardless of the downstream update outcome",
		);
		assertTrue(
			typeof failing.run.burrowRunId === "string" && failing.run.burrowRunId.length > 0,
			"POST /runs (bogus seed): burrowRunId attached — dispatch succeeded; only the extension write failed",
		);

		const events = await fetchAllEvents(http, failing.run.id);
		const failedEvent = events.find(
			(e) => e.kind === "seeds_extension_write_failed" && e.stream === "system",
		);
		if (failedEvent === undefined) {
			throw new AcceptanceError(
				`expected a seeds_extension_write_failed system event on run ${failing.run.id}; got kinds: ${summariseKinds(events)}`,
			);
		}
		const payload = failedEvent.payload ?? {};
		assertEqual(
			payload.seedId,
			BOGUS_SEED_ID,
			"seeds_extension_write_failed: payload.seedId echoes the bogus seed id",
		);
		assertTrue(
			typeof payload.reason === "string" && payload.reason.length > 0,
			`seeds_extension_write_failed: payload.reason is non-empty; got ${JSON.stringify(payload.reason)}`,
		);

		await cancelAndDrain(http, failing.run.id);

		// ----------------------------------------------------------------
		// Cleanup — restore source state so a re-run starts clean and
		// downstream scenarios see the baseline fixture.
		// ----------------------------------------------------------------
		await resetSourceState(ctx.fixtures.sampleProjectPath);
		await refreshProject(http, project.id);
	},
};

function seedRow(id: string): string {
	const row = {
		id,
		title: `scenario-22 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_CREATED_AT,
		updatedAt: SEED_CREATED_AT,
	};
	return `${JSON.stringify(row)}\n`;
}

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function refreshProject(http: WarrenHttp, projectId: string): Promise<RefreshResponse> {
	return http.expectJson<RefreshResponse>(
		"POST",
		`/projects/${encodeURIComponent(projectId)}/refresh`,
		200,
	);
}

interface SeedExtensions {
	readonly role?: string;
	readonly trigger?: string;
	readonly lastRunId?: string;
	readonly lastRunAt?: string;
	readonly scheduledFor?: string | null;
	readonly lastScheduledRun?: string | null;
}

interface SeedRowOnDisk {
	readonly id: string;
	readonly status: string;
	readonly extensions?: SeedExtensions;
}

async function requireSeedRow(path: string, id: string): Promise<SeedRowOnDisk> {
	const body = await readFile(path, "utf8");
	let found: SeedRowOnDisk | undefined;
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed) as SeedRowOnDisk;
			if (parsed.id === id) found = parsed;
		} catch {
			// Skip unparseable lines — other writers may have appended noise.
		}
	}
	if (found === undefined) {
		throw new AcceptanceError(`expected seed row id=${id} in ${path}; file was:\n${body}`);
	}
	return found;
}

async function fetchAllEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

function summariseKinds(events: readonly EventRow[]): string {
	const counts = new Map<string, number>();
	for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
	return Array.from(counts.entries())
		.map(([k, n]) => `${k}×${n}`)
		.join(", ");
}

async function cancelAndDrain(http: WarrenHttp, runId: string): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch {
		// Best-effort — the run may already be terminal.
	}
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		if (TERMINAL_STATES.has(row.state)) return;
		await sleep(100);
	}
	// Don't fail the scenario on a stuck terminal transition — teardown
	// kills the warren+burrow pair regardless.
}

async function resetSourceState(sourceRepoPath: string): Promise<void> {
	const seedsFile = join(sourceRepoPath, ".seeds", "issues.jsonl");
	if (existsSync(seedsFile)) {
		const body = await readFile(seedsFile, "utf8");
		const lines = body.split("\n").filter((l) => l.trim() !== "");
		const filtered = lines.filter((l) => {
			try {
				const parsed = JSON.parse(l) as { id?: unknown };
				const id = typeof parsed.id === "string" ? parsed.id : "";
				return id !== TARGET_SEED_ID;
			} catch {
				return true;
			}
		});
		const expected = filtered.length === 0 ? "" : `${filtered.join("\n")}\n`;
		if (expected !== body) {
			await writeFile(seedsFile, expected);
		}
	}

	await runGit(sourceRepoPath, ["add", "-A"]);
	const status = await runGit(sourceRepoPath, ["status", "--porcelain"]);
	if (status.stdout.trim() === "") return;
	await runGit(sourceRepoPath, ["commit", "-m", "scenario-22: reset"]);
}

async function commitInSource(sourceRepoPath: string, message: string): Promise<void> {
	await runGit(sourceRepoPath, ["add", "-A"]);
	await runGit(sourceRepoPath, ["commit", "-m", message]);
}

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "/tmp",
			GIT_AUTHOR_NAME: "Warren Acceptance",
			GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
			GIT_COMMITTER_NAME: "Warren Acceptance",
			GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new AcceptanceError(
			`git ${args.join(" ")} in ${cwd} exited ${exitCode}\nstderr: ${stderr}`,
		);
	}
	return { stdout, stderr };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

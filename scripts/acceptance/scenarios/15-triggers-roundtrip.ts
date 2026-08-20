/**
 * Scenario 15 — triggers round-trip (R-06, pl-2f15 step 7).
 *
 * Acceptance criterion #8 of pl-2f15:
 *   "Scenario 15 passes against a live in-proc warren+burrow: cron fire
 *    (no double-dispatch), scheduledFor past+future, missing-seed skip."
 *
 * Three pieces of the R-06 scheduler are exercised end-to-end against the
 * real in-proc warren+burrow:
 *
 *   1. POST /projects/:id/triggers/:triggerId/run — the Run Now surface
 *      (warren-99c3) dispatches a real run, persists `lastFiredAt` +
 *      `lastRunId` on the warren-side triggers row, and GET /triggers
 *      reflects the persisted state alongside a fresh cron next-fire.
 *
 *   2. The scheduler tick (WARREN_SCHEDULER_TICK_MS=1000, set in the
 *      harness boot env per scripts/acceptance/run.ts) picks up
 *      `extensions.scheduledFor <= now` seeds and dispatches a run with
 *      trigger='scheduled'. The seed's scheduledFor is then cleared and
 *      lastScheduledRun is written back via `sd update --extensions`,
 *      which we assert on the project clone's .seeds/issues.jsonl.
 *
 *   3. Negative cases — `scheduledFor` in the future, and closed seeds
 *      with scheduledFor set, never dispatch. The configured cron
 *      expression (`0 0 * * *`) won't elapse during the test window so
 *      no spontaneous trigger='cron' runs appear, certifying the
 *      no-double-dispatch posture for the cron path: once Run Now stamps
 *      the warren-side row, subsequent ticks see prev <= last and skip.
 *
 * Modes: in-proc only. Mirrors scenario 14's rationale — container mode
 * does not bind-mount the host sample project (mx-96d833), so the
 * source-repo edits this scenario drives aren't visible inside the
 * container.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { pollAcceptance } from "../lib/poll.ts";

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
	readonly prompt: string;
}

interface TriggerSummaryWire {
	readonly id: string;
	readonly kind: "cron";
	readonly cron: string;
	readonly seed: string;
	readonly role: string;
	readonly lastFiredAt: string | null;
	readonly nextFireAt: string | null;
	readonly lastRunId: string | null;
	readonly parseError: string | null;
}

interface ListRunsResponse {
	readonly runs: readonly RunRow[];
}

interface ListTriggersResponse {
	readonly triggers: readonly TriggerSummaryWire[];
	readonly errors: readonly { file: string; code: string; message: string }[];
}

interface RunNowResponse {
	readonly run: RunRow;
	readonly sandbox: { id: string; workspacePath: string };
}

interface RefreshResponse {
	readonly project: ProjectRow;
}

const TRIGGER_ID = "scenario-15-daily";
// Daily midnight UTC — guaranteed not to elapse during this scenario's
// run, so any trigger='cron' run we see is a regression.
const TRIGGER_CRON = "0 0 * * *";
const TRIGGER_SEED = "warren-scenario-15-target";
const PAST_SEED_ID = "ah-scenario-15-past";
const FUTURE_SEED_ID = "ah-scenario-15-future";
const CLOSED_SEED_ID = "ah-scenario-15-closed";
const PAST_TS = "2026-05-08T00:00:00.000Z";
const FUTURE_TS = "2099-01-01T00:00:00.000Z";
// Spawn-then-stub takes a few seconds (burrow up + dispatch); 18s leaves
// generous headroom for the 1s scheduler tick to observe + dispatch.
const SCHEDULED_DISPATCH_BUDGET_MS = 18_000;
const POLL_INTERVAL_MS = 200;
// Quiet window after the scheduled dispatch — long enough for at least
// one extra tick so a misbehaving dispatcher has time to emit a second
// run if it's going to.
const NO_DOUBLE_DISPATCH_WINDOW_MS = 3_000;

export const scenario: Scenario = {
	id: "15",
	title:
		"Triggers — cron Run Now persists, scheduledFor past fires, future + closed skip (no double-dispatch)",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// stub-shell must be in warren's agents registry before any spawn —
		// seeded at boot via WARREN_SEED_AGENTS_FILE (warren-e376); the
		// POST /agents/refresh endpoint was deleted in pl-3a79.
		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);

		// Restore source state in case a prior pass (or sibling scenario)
		// left edits behind; mirrors scenario-14's idempotent setup.
		await resetSourceState(ctx.fixtures.sampleProjectPath);
		await refreshProject(http, project.id);

		// Baseline counts so assertions are deltas — earlier scenarios
		// (03/04/05/06/09/10) leave runs on this project.
		const baseline = await snapshotRunCounts(http, project.id);

		// ----------------------------------------------------------------
		// Write `.warren/` + scheduled seed rows into the source repo.
		// ----------------------------------------------------------------
		const warrenDirInSource = join(ctx.fixtures.sampleProjectPath, ".warren");
		const seedsDirInSource = join(ctx.fixtures.sampleProjectPath, ".seeds");
		await mkdir(warrenDirInSource, { recursive: true });

		const triggersYaml = [
			`- id: ${TRIGGER_ID}`,
			"  kind: cron",
			`  cron: '${TRIGGER_CRON}'`,
			`  seed: ${TRIGGER_SEED}`,
			`  role: ${ctx.fixtures.stubAgentName}`,
			"",
		].join("\n");
		// defaultRole is what `dispatchScheduledSeed` uses to pick the agent
		// for scheduledFor seeds (no per-seed role in extensions today).
		// defaultPrompt left unset so each scheduled run gets the
		// "Work on seed <id>" fallback — gives us a per-seed prompt we can
		// assert against without persisted run metadata.
		const defaultsJson = JSON.stringify({ defaultRole: ctx.fixtures.stubAgentName }, null, 2);
		await writeFile(join(warrenDirInSource, "triggers.yaml"), triggersYaml);
		await writeFile(join(warrenDirInSource, "defaults.json"), defaultsJson);

		// `sd list` refuses to run without `.seeds/config.yaml`; the
		// fixture seeds only `.seeds/issues.jsonl` (mx-… seed-only fixture),
		// so we bootstrap config.yaml here. Idempotent — checked before write.
		const seedsConfig = join(seedsDirInSource, "config.yaml");
		if (!existsSync(seedsConfig)) {
			await writeFile(
				seedsConfig,
				`project: "${ctx.fixtures.sampleProjectName}"\nversion: "1"\nmax_plan_depth: 3\n`,
			);
		}

		// Append the three scheduled seed rows. The fixture's initial
		// `ah-stub-1` row stays untouched so reap-roundtrip scenarios on
		// re-run still see it.
		const extra = [
			seedRow(PAST_SEED_ID, "open", PAST_TS),
			seedRow(FUTURE_SEED_ID, "open", FUTURE_TS),
			seedRow(CLOSED_SEED_ID, "closed", PAST_TS),
		].join("");
		await appendFile(join(seedsDirInSource, "issues.jsonl"), extra);

		await commitInSource(
			ctx.fixtures.sampleProjectPath,
			"scenario-15: add .warren/ + scheduled seeds",
		);
		await refreshProject(http, project.id);

		// ----------------------------------------------------------------
		// Run Now on the cron trigger — exercises the HTTP dispatch path
		// and the lastFiredAt / lastRunId persistence side-effect.
		// ----------------------------------------------------------------
		const runNow = await http.expectJson<RunNowResponse>(
			"POST",
			`/projects/${encodeURIComponent(project.id)}/triggers/${TRIGGER_ID}/run`,
			201,
		);
		assertEqual(
			runNow.run.trigger,
			"manual-trigger",
			"Run Now: dispatched run carries trigger='manual-trigger'",
		);
		assertEqual(
			runNow.run.agentName,
			ctx.fixtures.stubAgentName,
			"Run Now: agentName matches the trigger role",
		);

		const triggersAfterRunNow = await listTriggers(http, project.id);
		assertEqual(triggersAfterRunNow.errors.length, 0, "GET /triggers: no per-file errors");
		assertEqual(
			triggersAfterRunNow.triggers.length,
			1,
			"GET /triggers: exactly one trigger summary",
		);
		const summary = triggersAfterRunNow.triggers[0];
		if (summary === undefined) {
			throw new AcceptanceError("GET /triggers: missing trigger summary entry");
		}
		assertEqual(summary.id, TRIGGER_ID, "GET /triggers: id round-trips");
		assertEqual(summary.cron, TRIGGER_CRON, "GET /triggers: cron round-trips");
		assertEqual(summary.parseError, null, "GET /triggers: cron parses cleanly");
		assertEqual(summary.lastRunId, runNow.run.id, "GET /triggers: lastRunId matches Run Now id");
		assertTrue(summary.lastFiredAt !== null, "GET /triggers: lastFiredAt persisted after Run Now");
		assertTrue(summary.nextFireAt !== null, "GET /triggers: nextFireAt recomputed from croner");

		// ----------------------------------------------------------------
		// Wait for the scheduler tick to dispatch the past-due seed.
		// ----------------------------------------------------------------
		const scheduledRun = await waitForScheduledRun(http, project.id, baseline.scheduled);
		assertEqual(
			scheduledRun.trigger,
			"scheduled",
			"scheduler tick: dispatched run has trigger='scheduled'",
		);
		assertEqual(
			scheduledRun.agentName,
			ctx.fixtures.stubAgentName,
			"scheduler tick: agentName matches defaults.defaultRole",
		);
		assertTrue(
			scheduledRun.prompt.includes(PAST_SEED_ID),
			`scheduler tick: dispatched run prompt references the past-due seed; got ${JSON.stringify(scheduledRun.prompt)}`,
		);

		// ----------------------------------------------------------------
		// Quiet window: another tick or two must NOT spawn a duplicate
		// scheduled run, AND must not fire the cron (its slot doesn't
		// elapse during the test).
		// warren-bb51: the harness's ONE remaining sleep. It cannot be a
		// poll — it asserts a negative over wall-clock time ("no second
		// dispatch arrives during this window"), and a poll can only
		// observe that a condition holds, never that it kept holding.
		// ----------------------------------------------------------------
		await sleep(NO_DOUBLE_DISPATCH_WINDOW_MS);
		const counts = await snapshotRunCounts(http, project.id);
		assertEqual(
			counts.scheduled - baseline.scheduled,
			1,
			`no double-dispatch: exactly one trigger='scheduled' run since baseline; got ${counts.scheduled - baseline.scheduled}`,
		);
		assertEqual(
			counts.cron - baseline.cron,
			0,
			`no spontaneous cron fire: zero trigger='cron' runs since baseline; got ${counts.cron - baseline.cron} (cron='${TRIGGER_CRON}' should not elapse during this scenario)`,
		);
		assertEqual(
			counts.manualTrigger - baseline.manualTrigger,
			1,
			`exactly one Run Now run since baseline; got ${counts.manualTrigger - baseline.manualTrigger}`,
		);

		// ----------------------------------------------------------------
		// Disk assertion — `sd update --extensions` cleared scheduledFor
		// on the dispatched seed and recorded lastScheduledRun; future
		// and closed seeds are untouched.
		// ----------------------------------------------------------------
		const seedsPath = join(project.localPath, ".seeds", "issues.jsonl");
		const seedRows = await readAllSeedRows(seedsPath);
		const pastRow = seedRows.get(PAST_SEED_ID);
		const futureRow = seedRows.get(FUTURE_SEED_ID);
		const closedRow = seedRows.get(CLOSED_SEED_ID);
		if (pastRow === undefined || futureRow === undefined || closedRow === undefined) {
			throw new AcceptanceError(
				`expected past/future/closed seeds in project clone .seeds; got ids [${Array.from(seedRows.keys()).join(", ")}]`,
			);
		}
		assertEqual(
			pastRow.extensions?.scheduledFor ?? null,
			null,
			"past-due seed: scheduledFor cleared after dispatch",
		);
		assertEqual(
			pastRow.extensions?.lastScheduledRun ?? null,
			scheduledRun.id,
			"past-due seed: lastScheduledRun records the dispatched run id",
		);
		assertEqual(
			futureRow.extensions?.scheduledFor ?? null,
			FUTURE_TS,
			"future seed: scheduledFor unchanged (not yet due)",
		);
		assertEqual(
			closedRow.extensions?.scheduledFor ?? null,
			PAST_TS,
			"closed seed: scheduledFor unchanged (closed seeds skip)",
		);

		// ----------------------------------------------------------------
		// Cleanup — restore the fixture so a re-run starts from the same
		// post-fixture state. The harness shares one source repo across
		// the whole suite (same posture as scenario 14).
		// ----------------------------------------------------------------
		await resetSourceState(ctx.fixtures.sampleProjectPath);
		await refreshProject(http, project.id);
	},
};

function seedRow(id: string, status: "open" | "closed", scheduledFor: string): string {
	const row = {
		id,
		title: `scenario-15 ${id}`,
		status,
		type: "task",
		priority: 3,
		createdAt: PAST_TS,
		updatedAt: PAST_TS,
		extensions: { scheduledFor },
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

async function listTriggers(http: WarrenHttp, projectId: string): Promise<ListTriggersResponse> {
	return http.expectJson<ListTriggersResponse>(
		"GET",
		`/projects/${encodeURIComponent(projectId)}/triggers`,
		200,
	);
}

interface RunCounts {
	readonly scheduled: number;
	readonly cron: number;
	readonly manualTrigger: number;
}

async function snapshotRunCounts(http: WarrenHttp, projectId: string): Promise<RunCounts> {
	const res = await http.expectJson<ListRunsResponse>(
		"GET",
		`/runs?project=${encodeURIComponent(projectId)}`,
		200,
	);
	let scheduled = 0;
	let cron = 0;
	let manualTrigger = 0;
	for (const r of res.runs) {
		if (r.trigger === "scheduled") scheduled += 1;
		else if (r.trigger === "cron") cron += 1;
		else if (r.trigger === "manual-trigger") manualTrigger += 1;
	}
	return { scheduled, cron, manualTrigger };
}

async function waitForScheduledRun(
	http: WarrenHttp,
	projectId: string,
	baselineScheduledCount: number,
): Promise<RunRow> {
	return pollAcceptance({
		label: "trigger='scheduled' run",
		id: projectId,
		timeoutMs: SCHEDULED_DISPATCH_BUDGET_MS,
		intervalMs: POLL_INTERVAL_MS,
		fetchRow: async () => {
			const res = await http.expectJson<ListRunsResponse>(
				"GET",
				`/runs?project=${encodeURIComponent(projectId)}`,
				200,
			);
			const scheduled = res.runs.filter((r) => r.trigger === "scheduled");
			// Caller's baseline is 0 in practice (no prior scenario uses
			// trigger='scheduled'), so the new entry is unambiguous.
			return scheduled.length > baselineScheduledCount ? (scheduled[0] ?? null) : null;
		},
		isDone: (run): run is RunRow => run !== null,
		describe: (run) => (run === null ? "not dispatched yet" : run.id),
	});
}

interface SeedExtensions {
	readonly scheduledFor?: string | null;
	readonly lastScheduledRun?: string | null;
}

interface SeedRowOnDisk {
	readonly id: string;
	readonly status: string;
	readonly extensions?: SeedExtensions;
}

async function readAllSeedRows(path: string): Promise<Map<string, SeedRowOnDisk>> {
	const body = await readFile(path, "utf8");
	const rows = new Map<string, SeedRowOnDisk>();
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed) as SeedRowOnDisk;
			if (typeof parsed.id === "string") rows.set(parsed.id, parsed);
		} catch {
			// Skip unparseable lines (other writers may have appended noise).
		}
	}
	return rows;
}

async function resetSourceState(sourceRepoPath: string): Promise<void> {
	// Remove `.warren/` and strip our three scheduled seeds; restore
	// `.seeds/issues.jsonl` to the pre-scenario state. Idempotent —
	// no-ops if state is already clean.
	const warrenDir = join(sourceRepoPath, ".warren");
	if (existsSync(warrenDir)) {
		await rm(warrenDir, { recursive: true, force: true });
	}

	const seedsFile = join(sourceRepoPath, ".seeds", "issues.jsonl");
	if (existsSync(seedsFile)) {
		const body = await readFile(seedsFile, "utf8");
		const lines = body.split("\n").filter((l) => l.trim() !== "");
		const filtered = lines.filter((l) => {
			try {
				const parsed = JSON.parse(l) as { id?: unknown };
				const id = typeof parsed.id === "string" ? parsed.id : "";
				return id !== PAST_SEED_ID && id !== FUTURE_SEED_ID && id !== CLOSED_SEED_ID;
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
	await runGit(sourceRepoPath, ["commit", "-m", "scenario-15: reset"]);
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

/** The harness's single sanctioned sleep (warren-bb51) — no new call sites; use waitForRun / pollAcceptance. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

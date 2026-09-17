/**
 * Scenario 45 — Warren-armed auto-merge end to end (plan pl-92a3 step 8 /
 * warren-d139): warren arms the forge's own auto-merge right after reap
 * opens a pull request, gated on the project's `pr.autoMerge` block and the
 * fail-closed arming policy.
 *
 * Topology mirrors scenario 40 (closest twin): a scenario-owned warren boot
 * under `WARREN_FORGE=fake`, with the fake in its arm-capable mode
 * (`WARREN_FAKE_FORGE_AUTO_MERGE_ARM=1` — the registry's explicit
 * non-default mode, design record §2.2). The project is a PRIVATE clone of
 * the shared sample fixture carrying a committed `.warren/config.yaml`
 * with `pr.autoMerge: { method: squash, protectedPaths: [".seeds/"] }`, so
 * the scenario never mutates the shared fixture and stays idempotent.
 *
 * The assertions:
 *
 *   1. Run A (the `touchfile` stub knob commits `agent-output/<id>.txt` —
 *      no protected path) reaps `succeeded` with an open PR and a
 *      `reap.auto_merge_armed` event carrying `{ prUrl, prNumber, method,
 *      outcome }` with `method: "squash"` and `outcome: "armed"`.
 *   2. FakeForge RECORDED the arm call: the state file's PR record reads
 *      `autoMerge: "armed"` (the cross-process observation seam,
 *      `WARREN_FAKE_FORGE_STATE_FILE`).
 *   3. Run B (the `closeseed` stub knob commits `.seeds/issues.jsonl` — a
 *      `protectedPaths` match) reaps `succeeded` too (arming never fails a
 *      run) with a `reap.auto_merge_skipped` event carrying
 *      `reason: "protected_path"` and the matched `paths`, and NO armed
 *      event. Its state-file record stays `unarmed` — no arm call was made.
 *
 * In-proc only (same rationale as 40): the private fixture, the `fake://`
 * clone URL, and the arm-capable boot are in-process harness plumbing.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import { waitForRunTerminal } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly prUrl: string | null;
}

interface EventRow {
	readonly kind: string;
	readonly payload: Record<string, unknown> | null;
}

/** Read-only view over the persisted `FakeForgeStateFile` (src/forge/fake/store.ts). */
interface FakeStateView {
	readonly prs: Record<
		string,
		readonly {
			readonly number: number;
			readonly headBranch: string;
			readonly baseBranch: string;
			readonly lifecycle: string;
			readonly autoMerge: string;
		}[]
	>;
}

const FAKE_PROJECT_URL = "fake://warren-acceptance/sample-auto-merge";
const FAKE_REPO_KEY = "warren-acceptance/sample-auto-merge";
const RUN_DEADLINE_MS = 60_000;
const PROTECTED_ENTRY = ".seeds/";
const ARMED_EVENT = "reap.auto_merge_armed";
const SKIPPED_EVENT = "reap.auto_merge_skipped";
const NOT_ARMED_EVENT = "reap.auto_merge_not_armed";

export const scenario: Scenario = {
	id: "45",
	title:
		"Warren-armed auto-merge — pr.autoMerge opts in, the fake forge arms the PR, a protected path skips arming (pl-92a3)",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-45-"));
		let handle: BootHandle | undefined;
		try {
			// Private project fixture: a clone of the shared sample carrying a
			// COMMITTED .warren/config.yaml with pr.autoMerge. The clone keeps
			// burrow.toml, .seeds/, and the stub tools the harness needs, and a
			// fresh clone per scenario run keeps every assertion idempotent.
			const projectFixture = join(scenarioRoot, "project-source");
			await runGit(scenarioRoot, [
				"clone",
				"--quiet",
				ctx.fixtures.sampleProjectPath,
				projectFixture,
			]);
			await mkdir(join(projectFixture, ".warren"), { recursive: true });
			await writeFile(
				join(projectFixture, ".warren", "config.yaml"),
				[
					"# scenario-45 — warren-armed auto-merge opt-in",
					"pr:",
					"  autoMerge:",
					"    method: squash",
					"    protectedPaths:",
					`      - ${PROTECTED_ENTRY}`,
					"",
				].join("\n"),
			);
			await runGit(projectFixture, ["add", ".warren/config.yaml"]);
			await runGit(projectFixture, ["commit", "-m", "scenario-45: opt into pr.autoMerge"]);

			const gitConfigPath = join(scenarioRoot, "git-config");
			const stateFile = join(scenarioRoot, "fake-forge-state.json");
			const harnessConfig = existsSync(ctx.fixtures.gitConfigPath)
				? await readFile(ctx.fixtures.gitConfigPath, "utf8")
				: "";
			await writeFile(
				gitConfigPath,
				`${harnessConfig.trimEnd()}\n[url "${projectFixture}"]\n\tinsteadOf = ${FAKE_PROJECT_URL}\n`,
			);

			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_FORGE: "fake",
					// Cross-process observation seam — same as scenario 40.
					WARREN_FAKE_FORGE_STATE_FILE: stateFile,
					// The fake's arm-capable mode (pl-92a3 §2.2): the explicit
					// non-default boot this scenario exists to exercise.
					WARREN_FAKE_FORGE_AUTO_MERGE_ARM: "1",
				},
			});
			ctx.logger.info(`scenario-45: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });

			// === 1. Register the opted-in project ===
			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: FAKE_PROJECT_URL },
			});

			// === 2. Run A: an ordinary file commit arms auto-merge ===
			const runA = await dispatch(http, project.id, "scenario-45 arm — touchfile am45-arm");
			const eventsA = await runEvents(http, runA.id);
			const armed = requireEvent(eventsA, ARMED_EVENT, runA.id);
			assertEqual(
				armed.payload?.method,
				"squash",
				"reap.auto_merge_armed carries the configured method",
			);
			assertEqual(armed.payload?.outcome, "armed", "reap.auto_merge_armed outcome is 'armed'");
			assertEqual(armed.payload?.prNumber, 1, "reap.auto_merge_armed names PR 1");
			assertEqual(armed.payload?.prUrl, runA.prUrl, "reap.auto_merge_armed carries the PR URL");
			assertEqual(optionalEvent(eventsA, SKIPPED_EVENT), undefined, "run A emits no skipped event");
			assertEqual(
				optionalEvent(eventsA, NOT_ARMED_EVENT),
				undefined,
				"run A emits no not-armed event",
			);

			// === 3. FakeForge recorded the arm call ===
			const recordA = stateFileRecord(stateFile, FAKE_REPO_KEY, 0);
			assertEqual(recordA.autoMerge, "armed", "the fake's PR record reads autoMerge 'armed'");

			// === 4. Run B: a protected-path diff skips arming, never fails the run ===
			// `closeseed` commits .seeds/issues.jsonl — a protectedPaths match.
			const runB = await dispatch(http, project.id, "scenario-45 skip — closeseed ah-stub-1");
			const eventsB = await runEvents(http, runB.id);
			const skipped = requireEvent(eventsB, SKIPPED_EVENT, runB.id);
			assertEqual(
				skipped.payload?.reason,
				"protected_path",
				"reap.auto_merge_skipped names the protected_path reason",
			);
			assertTrue(
				Array.isArray(skipped.payload?.paths) &&
					(skipped.payload.paths as string[]).includes(".seeds/issues.jsonl"),
				`reap.auto_merge_skipped lists the matched path; got ${JSON.stringify(skipped.payload?.paths)}`,
			);
			assertEqual(
				optionalEvent(eventsB, ARMED_EVENT),
				undefined,
				"the protected-path run emits no armed event",
			);
			assertEqual(
				optionalEvent(eventsB, NOT_ARMED_EVENT),
				undefined,
				"the protected-path run emits no not-armed event",
			);

			// === 5. The fake never saw an arm call for the protected PR ===
			const recordB = stateFileRecord(stateFile, FAKE_REPO_KEY, 1);
			assertEqual(
				recordB.autoMerge,
				"unarmed",
				"the protected PR's fake record stays unarmed — no arm call was made",
			);

			ctx.logger.info("scenario-45: warren-armed auto-merge verified");
		} finally {
			await handle?.stop();
			await rm(scenarioRoot, { recursive: true, force: true });
		}
	},
};

/** Dispatch one stub-agent run and require a succeeded reap with an open PR. */
async function dispatch(http: WarrenHttp, projectId: string, prompt: string): Promise<RunRow> {
	const created = await http.expectJson<{ run: RunRow }>("POST", "/runs", 201, {
		body: { agent: "claude-code", project: projectId, prompt },
	});
	const terminal = await waitForRunTerminal(http, created.run.id, RUN_DEADLINE_MS);
	if (terminal.state !== "succeeded" || terminal.prUrl === null) {
		throw new AcceptanceError(
			`run ${created.run.id} ended '${terminal.state}' with prUrl=${terminal.prUrl}; expected succeeded with an open PR`,
		);
	}
	return terminal;
}

/** Read the run's full event stream (same shape scenario 40 asserts on). */
async function runEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

/** Require one event by kind; a miss is an AcceptanceError. */
function requireEvent(events: readonly EventRow[], kind: string, runId: string): EventRow {
	const found = events.find((e) => e.kind === kind);
	if (found === undefined) {
		throw new AcceptanceError(
			`run ${runId}: event stream missing '${kind}'; saw kinds=[${events.map((e) => e.kind).join(", ")}]`,
		);
	}
	return found;
}

/** Find one event by kind, or undefined — the optional-miss shape. */
function optionalEvent(events: readonly EventRow[], kind: string): EventRow | undefined {
	return events.find((e) => e.kind === kind);
}

/** Read one PR record out of the persisted fake-forge state file. */
function stateFileRecord(stateFile: string, repoKey: string, index: number) {
	if (!existsSync(stateFile)) {
		throw new AcceptanceError("FakeForge state file missing — no PR was ever recorded");
	}
	const state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeStateView;
	const record = state.prs[repoKey]?.[index];
	if (record === undefined) {
		throw new AcceptanceError(
			`FakeForge state file has no PR record ${index} for ${repoKey}; keys=[${Object.keys(state.prs).join(", ")}]`,
		);
	}
	return record;
}

/** Run git with the harness identity (no global [user] section — warren-9f70). */
async function runGit(cwd: string, args: readonly string[]): Promise<void> {
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
			`git ${args.join(" ")} in ${cwd} exited ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
		);
	}
}

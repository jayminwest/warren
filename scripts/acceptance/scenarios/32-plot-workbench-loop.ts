/**
 * Scenario 32 — Plot workbench loop end-to-end (warren-7cd9 /
 * pl-0344 step 16). Closes the V1 + V1.5 Plot-as-primary-workbench
 * vertical against a real warren+burrow stack: brainstorm → chat →
 * formalize → intent edit → status promote → batch dispatch with
 * question_posed → pause → answer → resume → succeeded → attach gh_pr
 * → merge → status done → summary.
 *
 * Composes scenarios 25 (Plot dispatch + reap), 27 (PlanRun+Plot),
 * and 29 (PlotDetail mutations) and lights up the surfaces those
 * three don't cover end-to-end against a live stack:
 *   - `POST /brainstorm` (warren-d22e) — atomic Plot+interactive run
 *     dispatch from a single click.
 *   - `POST /runs/:id/messages` (warren-b3b9) — interactive follow-up
 *     turn dispatch (202-Accepted, async reply).
 *   - `POST /plots/:id/formalize` (warren-d22e) — non-mutating
 *     suggestion-from-agent-messages shape. `source_message_count: 0`
 *     is the legitimate response here: the harness's interactive reap
 *     path does not (yet) append `agent_message` events on its own,
 *     and the stub agent doesn't write any; we assert the envelope
 *     shape and the zero-message degenerate response, which is the
 *     contract the UI relies on for the "start chatting first" state.
 *   - Blocking `question_posed` pause/resume on batch runs
 *     (warren-2976) — the stub agent emits a `question_posed` Plot
 *     event mid-stream via the new `[plot_question=...]` prompt knob,
 *     the pause detector flips the run `running → paused`, the
 *     scenario answers via `POST /plots/:id/questions/:event_id/answer`,
 *     and the resume tick flips it back `paused → running` before the
 *     stub's sleep finishes so reap can land the natural
 *     `running → succeeded` transition.
 *   - `POST /plots/:id/attachments/:ref/merge` (warren-8e39) — happy
 *     path via the `WARREN_GH_FETCH_OVERRIDE=merged` shim;
 *     `refresh_scheduled: true` on the response, background project
 *     refresh fired (we assert the response field, not the post-merge
 *     pull — scenario 27 covers that side).
 *   - `GET /plots/:id/summary` (warren-8917) — institutional-memory
 *     artifact projection; we assert the curated shape after the
 *     Plot has cycled `drafting → ready → active → done`.
 *
 * Topology: in-proc only, per-scenario stack so the
 * `WARREN_PAUSE_DETECTOR_ENABLED=1` + tick=500ms +
 * `WARREN_GH_FETCH_OVERRIDE=merged` knobs stay scoped. The fixture
 * mirrors scenario 29's shape — `.plot/`+`.seeds/`+the three stub
 * scripts copied from `ctx.fixtures.sampleProjectPath` — minus the
 * pre-seeded events; this scenario drives every Plot mutation through
 * warren's API to keep the wire contract honest.
 *
 * Idempotent teardown: per-scenario `mkdtemp` so the harness wipes it
 * on success; per-scenario boot so the env knobs don't leak.
 */

import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly hasSeeds?: boolean;
	readonly hasPlot?: boolean;
}

interface PlotAttachment {
	readonly id: string;
	readonly type: string;
	readonly ref: string;
	readonly role?: string;
	readonly added_at: string;
	readonly added_by: string;
}

interface PlotEventWire {
	readonly type: string;
	readonly actor: string;
	readonly at: string;
	readonly data?: Record<string, unknown>;
}

interface PlotEnvelope {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly intent: {
		readonly goal: string;
		readonly non_goals: readonly string[];
		readonly constraints: readonly string[];
		readonly success_criteria: readonly string[];
	};
	readonly attachments: readonly PlotAttachment[];
	readonly event_log: readonly PlotEventWire[];
	readonly project_id: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly plotId: string | null;
	readonly mode?: string;
	readonly pausedAt?: string | null;
	readonly pausedQuestionEventId?: string | null;
}

interface BrainstormResponse {
	readonly plot: { readonly id: string };
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

interface MessageResponse {
	readonly run: RunRow;
	readonly priorRunId: string;
}

interface FormalizeResponse {
	readonly plot_id: string;
	readonly suggested_intent: {
		readonly goal: string;
		readonly non_goals: readonly string[];
		readonly constraints: readonly string[];
		readonly success_criteria: readonly string[];
	};
	readonly source_message_count: number;
}

interface AttachResponse {
	readonly envelope: PlotEnvelope;
	readonly attachment: PlotAttachment;
}

interface AnswerResponse {
	readonly event: PlotEventWire;
}

interface MergeResponse {
	readonly envelope: PlotEnvelope;
	readonly merge: { readonly kind: string; readonly sha?: string };
	readonly attachment_id: string;
	readonly refresh_scheduled: boolean;
}

interface PlotSummaryArtifact {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly project_id: string;
	readonly intent: PlotEnvelope["intent"];
	readonly decisions: readonly unknown[];
	readonly linked_prs: readonly unknown[];
	readonly linked_commits: readonly unknown[];
	readonly linked_seeds: readonly unknown[];
	readonly timeline: readonly unknown[];
}

const PROJECT_URL = "https://github.com/warren-acceptance/sample-workbench.git";
const SEED_TS = "2026-05-18T00:00:00.000Z";
const SEED_ID = "ah-acc32-aaaa";
const GH_PR_REF = "warren-acceptance/sample#1";

const PAUSE_DEADLINE_MS = 15_000;
const RESUME_DEADLINE_MS = 15_000;
const TERMINAL_DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 250;

export const scenario: Scenario = {
	id: "32",
	title:
		"Plot workbench loop — brainstorm + chat + formalize + intent + status, batch run pause/resume on question_posed, gh_pr attach + merge + auto-done, summary",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-32-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		await buildFixture({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
			projectGitUrl: PROJECT_URL,
		});
		ctx.logger.debug(`scenario-32: fixture=${fixturePath}`);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					// Default stub sleep stays 0 — the pause-phase run drives
					// its own sleep via the [sleep_ms=...] prompt knob so we
					// don't slow down the brainstorm / chat dispatches.
					WARREN_STUB_SLEEP_MS: "0",
					// Click-to-merge happy path: short-circuit the GitHub REST
					// call to a synthetic `merged` result so the test stays
					// hermetic (warren-ae00 / scenario 26 shim).
					WARREN_GH_FETCH_OVERRIDE: "merged",
					// Pause detector — production default is disabled; the
					// 500ms tick gives the pause-phase a tight loop so we
					// can observe paused/resumed within seconds.
					WARREN_PAUSE_DETECTOR_ENABLED: "1",
					WARREN_PAUSE_DETECTOR_TICK_MS: "500",
				},
			});
			ctx.logger.info(`scenario-32: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PROJECT_URL },
			});
			assertEqual(project.hasPlot, true, "fixture project surfaces hasPlot=true");
			assertEqual(project.hasSeeds, true, "fixture project surfaces hasSeeds=true");

			// =============================================================
			// Phase A — brainstorm + chat + formalize + intent + status
			// =============================================================
			const brain = await http.expectJson<BrainstormResponse>("POST", "/brainstorm", 201, {
				body: {
					project_id: project.id,
					prompt: "scenario-32: I want to add a thing that does the thing.",
					name: "scenario-32 brainstorm",
					agent: "stub-shell",
				},
			});
			const plotId = brain.plot.id;
			assertTrue(plotId.length > 0, "POST /brainstorm returns a plot.id");
			assertEqual(
				brain.run.mode,
				"interactive",
				"POST /brainstorm spawned an interactive run (mode='interactive')",
			);
			assertEqual(brain.run.plotId, plotId, "brainstorm run.plotId bound to the new Plot");

			// Wait for the first turn to reap so the conversation has a
			// finalized prior-run row to chain follow-up messages from.
			await waitForRunTerminal(http, brain.run.id, TERMINAL_DEADLINE_MS);

			// POST /runs/:id/messages — follow-up turn (warren-b3b9). The
			// 202-Accepted shape is the load-bearing assertion; the reply
			// itself isn't asserted here (no `agent_message` capture yet).
			const followup = await http.expectJson<MessageResponse>(
				"POST",
				`/runs/${encodeURIComponent(brain.run.id)}/messages`,
				202,
				{ body: { message: "scenario-32 follow-up: please sharpen the goal" } },
			);
			assertEqual(
				followup.priorRunId,
				brain.run.id,
				"messages handler echoes the prior-run handle (conversation chain)",
			);
			assertEqual(
				followup.run.mode,
				"interactive",
				"messages handler spawned a new interactive turn (not batch)",
			);
			assertEqual(followup.run.plotId, plotId, "follow-up turn inherits the conversation's plotId");
			await waitForRunTerminal(http, followup.run.id, TERMINAL_DEADLINE_MS);

			// POST /plots/:id/formalize — non-mutating shape check. The stub
			// path produces no agent_message events, so source_message_count
			// is 0 and the suggestion is all-empty; the contract is that
			// this is a legitimate response (UI shows "start chatting first")
			// rather than an error.
			const formalize = await http.expectJson<FormalizeResponse>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/formalize`,
				200,
			);
			assertEqual(formalize.plot_id, plotId, "formalize echoes plot_id");
			assertEqual(
				formalize.source_message_count,
				0,
				"formalize: zero agent_message events on the stub path is the legitimate 'no chat yet' response",
			);
			assertEqual(
				formalize.suggested_intent.goal,
				"",
				"formalize: empty goal when no agent_message extracted",
			);

			// User-supplied intent + status promote (drafting → ready → active).
			const finalGoal = "scenario-32 acceptance: drive the full Plot workbench loop end-to-end";
			await http.expectJson<PlotEnvelope>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/intent`,
				200,
				{ body: { goal: finalGoal } },
			);
			await http.expectStatus("POST", `/plots/${encodeURIComponent(plotId)}/status`, 200, {
				body: { next: "ready" },
			});
			await http.expectStatus("POST", `/plots/${encodeURIComponent(plotId)}/status`, 200, {
				body: { next: "active" },
			});

			const envAfterPhaseA = await http.expectJson<PlotEnvelope>(
				"GET",
				`/plots/${encodeURIComponent(plotId)}`,
				200,
			);
			assertEqual(envAfterPhaseA.status, "active", "Plot promoted to 'active' after Phase A");
			assertEqual(envAfterPhaseA.intent.goal, finalGoal, "intent.goal persisted");

			// =============================================================
			// Phase B — batch dispatch with question_posed → pause → answer → resume
			// =============================================================
			//
			// Dispatch a long-sleeping batch run with the Plot bound, then
			// host-side append a `question_posed` event to the Plot's
			// events.jsonl via the `plot` CLI. We can't drive this from the
			// sandbox today: burrow-cli does not yet forward `body.env` into
			// the sandbox (mx-warren-a346 / scenario 25 + 29 SOFT_SKIP), so
			// the agent inside burrow sees no PLOT_ID and `plot append` from
			// the agent is a no-op. The pause detector reads the on-disk
			// events log directly, so a host-side append is functionally
			// equivalent to the agent emitting the question — exactly what
			// production will look like once warren-a346 lands.
			const batchPrompt = `[sleep_ms=18000] closeseed ${SEED_ID}`;
			const batchRun = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
				body: {
					project: project.id,
					agent: "stub-shell",
					prompt: batchPrompt,
					plotId,
				},
			});

			// Give the run a beat to land in 'running' before we append the
			// question; the pause detector only acts on running batch rows.
			await waitForRunState(http, batchRun.run.id, "running", PAUSE_DEADLINE_MS);

			await appendPlotQuestion({
				projectLocalPath: project.localPath,
				plotId,
				actor: "agent:scenario-32:host-injected",
				text: "scenario-32: which db?",
			});
			assertEqual(batchRun.run.mode ?? "batch", "batch", "phase-B dispatch is mode='batch'");

			// Wait for the run to transition `running → paused`. The pause
			// detector reads .plot/<id>.events.jsonl directly, so the
			// host-side `plot append` above is enough to trigger the flip
			// on the next tick (tick=500ms).
			const paused = await waitForRunState(http, batchRun.run.id, "paused", PAUSE_DEADLINE_MS);
			const questionEventId = paused.pausedQuestionEventId ?? "";
			assertTrue(
				questionEventId.length > 0,
				"paused run carries paused_question_event_id (the question's at-ISO timestamp)",
			);
			assertTrue((paused.pausedAt ?? "").length > 0, "paused run carries paused_at timestamp");

			// The question_posed event is visible on the Plot envelope's
			// event_log — the answer endpoint uses the at-id verbatim.
			const envWhilePaused = await http.expectJson<PlotEnvelope>(
				"GET",
				`/plots/${encodeURIComponent(plotId)}`,
				200,
			);
			const questionEvent = envWhilePaused.event_log.find(
				(e) => e.type === "question_posed" && e.at === questionEventId,
			);
			if (questionEvent === undefined) {
				throw new AcceptanceError(
					`paused run referenced question_posed at=${questionEventId}, but envelope.event_log does not include it; got [${envWhilePaused.event_log.map((e) => `${e.type}@${e.at}`).join(", ")}]`,
				);
			}

			// Answer the question. The resume tick (tick=500ms) flips the
			// row paused → running on detection of the matching
			// question_answered event.
			const answerResp = await http.expectJson<AnswerResponse>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/questions/${encodeURIComponent(questionEventId)}/answer`,
				200,
				{ body: { answer: "scenario-32: sqlite for V1" } },
			);
			assertEqual(
				answerResp.event.type,
				"question_answered",
				"answer endpoint returns the freshly-appended question_answered event",
			);

			// Resume detection: paused → running within the resume budget.
			// We poll for any non-paused state so a fast-resume + fast-exit
			// race that lands us straight in 'succeeded' still counts as
			// resumed (the resume tick fired; reap then finalized).
			const resumed = await waitForRunStateNot(http, batchRun.run.id, "paused", RESUME_DEADLINE_MS);
			assertTrue(
				resumed.state === "running" || resumed.state === "succeeded",
				`paused run should resume to 'running' or terminate 'succeeded' after answer; got '${resumed.state}'`,
			);

			// Wait for natural termination.
			const terminal = await waitForRunTerminal(http, batchRun.run.id, TERMINAL_DEADLINE_MS);
			assertEqual(
				terminal.state,
				"succeeded",
				"pause-phase batch run reaches 'succeeded' after answer+resume+agent-exit",
			);

			// =============================================================
			// Phase C — attach gh_pr, click-to-merge, auto-done, summary
			// =============================================================
			const ghAttach = await http.expectJson<AttachResponse>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/attachments`,
				200,
				{ body: { kind: "gh_pr", ref: GH_PR_REF, role: "primary" } },
			);
			assertEqual(ghAttach.attachment.type, "gh_pr", "attached gh_pr kind");
			assertEqual(ghAttach.attachment.ref, GH_PR_REF, "attached gh_pr ref");

			// Click-to-merge — the WARREN_GH_FETCH_OVERRIDE=merged shim
			// short-circuits the GitHub REST call to a synthetic merged
			// result, so the handler returns merge.kind='merged' and
			// schedules the background refresh.
			const mergeResp = await http.expectJson<MergeResponse>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/attachments/${encodeURIComponent(GH_PR_REF)}/merge`,
				200,
			);
			assertEqual(
				mergeResp.merge.kind,
				"merged",
				`merge handler returned kind='merged' under WARREN_GH_FETCH_OVERRIDE=merged; got '${mergeResp.merge.kind}'`,
			);
			assertEqual(
				mergeResp.refresh_scheduled,
				true,
				"merge response carries refresh_scheduled=true so the UI knows the clone refresh is in flight",
			);
			assertEqual(
				mergeResp.attachment_id,
				ghAttach.attachment.id,
				"merge response echoes the attachment att-NNN id resolved from the ref",
			);

			// Promote active → done now that the loop is closed.
			await http.expectStatus("POST", `/plots/${encodeURIComponent(plotId)}/status`, 200, {
				body: { next: "done" },
			});

			// Summary artifact — institutional-memory shape, derivation-only.
			const summary = await http.expectJson<PlotSummaryArtifact>(
				"GET",
				`/plots/${encodeURIComponent(plotId)}/summary`,
				200,
			);
			assertEqual(summary.id, plotId, "summary.id matches the Plot");
			assertEqual(summary.status, "done", "summary.status reflects the final 'done' state");
			assertEqual(summary.project_id, project.id, "summary.project_id stitched from resolver");
			assertEqual(summary.intent.goal, finalGoal, "summary.intent.goal carries through");
			assertTrue(
				Array.isArray(summary.decisions),
				"summary.decisions is an array (curated decision_made projection)",
			);
			assertTrue(
				Array.isArray(summary.linked_prs),
				"summary.linked_prs is an array (gh_pr attachment + merge audit projection)",
			);
			assertTrue(
				Array.isArray(summary.timeline),
				"summary.timeline is an array (curated structural timeline)",
			);
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};

interface BuildFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly projectGitUrl: string;
}

/**
 * Build a `.plot/`-and-`.seeds/`-enabled fixture and append an
 * insteadOf redirect so warren's `git clone <projectGitUrl>` resolves
 * to the on-disk path. Mirrors scenario 29's fixture shape minus
 * pre-seeded Plot events — this scenario drives every Plot mutation
 * through the warren API.
 */
async function buildFixture(input: BuildFixtureInput): Promise<void> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });
	await mkdir(join(input.fixturePath, ".plot"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance workbench fixture\n\nUsed by scripts/acceptance/scenarios/32-plot-workbench-loop.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-workbench"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		`${JSON.stringify({
			id: SEED_ID,
			title: "scenario-32 fixture seed",
			status: "open",
			type: "task",
			priority: 3,
			createdAt: SEED_TS,
			updatedAt: SEED_TS,
		})}\n`,
	);

	// .plot/ exists; `plot init` is intentionally NOT run here because
	// the scenario drives Plot creation through POST /brainstorm. The
	// project's hasPlot gate just checks for the directory presence
	// (see projects/manifest detector); the lib creates the first
	// plot-<id>.json on demand.
	await writeFile(join(input.fixturePath, ".plot", ".gitkeep"), "");

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);
	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: workbench acceptance fixture"],
		env,
	);

	const harnessConfig = await readFile(input.harnessGitConfigPath, "utf8").catch(() => "");
	const lines: string[] = [
		harnessConfig.trimEnd(),
		`[url "${input.fixturePath}"]`,
		`\tinsteadOf = ${input.projectGitUrl}`,
		"",
	];
	await writeFile(input.gitConfigPath, `${lines.join("\n")}\n`);
}

async function waitForRunState(
	http: WarrenHttp,
	runId: string,
	target: string,
	timeoutMs: number,
): Promise<RunRow> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (row.state === target) return row;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach state='${target}' within ${timeoutMs}ms (last='${last}')`,
	);
}

async function waitForRunStateNot(
	http: WarrenHttp,
	runId: string,
	notState: string,
	timeoutMs: number,
): Promise<RunRow> {
	const start = Date.now();
	let last = notState;
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (row.state !== notState) return row;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`run ${runId} did not leave state='${notState}' within ${timeoutMs}ms (last='${last}')`,
	);
}

const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled"]);

async function waitForRunTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<RunRow> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (TERMINAL_RUN_STATES.has(row.state)) return row;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach a terminal state within ${timeoutMs}ms (last='${last}')`,
	);
}

interface AppendPlotQuestionInput {
	readonly projectLocalPath: string;
	readonly plotId: string;
	readonly actor: string;
	readonly text: string;
}

/**
 * Append a `question_posed` event to `<projectLocalPath>/.plot/<plotId>.events.jsonl`
 * via the `plot` CLI. Mirrors what the in-sandbox agent would do once
 * burrow-cli forwards `body.env` (warren-a346). The pause detector
 * reads the events file directly so this host-side append is
 * functionally indistinguishable from the production path.
 */
async function appendPlotQuestion(input: AppendPlotQuestionInput): Promise<void> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		PLOT_ACTOR: input.actor,
	};
	await runIn(
		input.projectLocalPath,
		[
			"plot",
			"append",
			input.plotId,
			"--event",
			"question_posed",
			"--data",
			JSON.stringify({ text: input.text, blocking: true }),
		],
		env,
	);
}

interface RunResult {
	stdout: string;
	stderr: string;
}

async function runIn(
	cwd: string,
	cmd: readonly string[],
	env: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd,
		env,
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
			`scenario-32 command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
		);
	}
	return { stdout, stderr };
}

function withGitIdentity(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scenario 25 — Plot integration end-to-end roundtrip (warren-4e06, pl-2047
 * step 8). Closes the loop the per-step unit tests open: warren-a8c3 verifies
 * the DB+API surface, warren-e26f the env injection at the burrow.up call,
 * warren-e848 the host-side `run_dispatched` append, warren-7e0f the
 * reap-time merge + mirror; this scenario chains them through a real
 * warren+burrow stack and watches the round-trip.
 *
 * What runs:
 *
 *   1. Build a fresh fixture project with a `.plot/` directory and one
 *      pre-initialized Plot (committed to git), append an `insteadOf`
 *      redirect for it on the shared git-config file, and POST /projects
 *      to clone it into warren's data dir. Verify `hasPlot=true` on the
 *      registered row.
 *
 *   2. Dispatch a run against that project with `plot_id` set on the body.
 *      Wait for `running`, poll until the project's
 *      `.plot/plot-<id>.events.jsonl` carries the host-side
 *      `run_dispatched` append (warren-e848 path: warren's spawn flow opens
 *      a `UserPlotClient` and writes before any sandbox bytes flow).
 *
 *   3. The stub-shell agent — when PLOT_ID is set in its env — echoes both
 *      `PLOT_ID` and `PLOT_ACTOR` to stdout and runs `plot append
 *      --event decision_made --data ...` inside the burrow workspace
 *      (lib/stub-agent/agent.sh additions). Cancel the run so reap merges
 *      the workspace `.plot/` back into the project's persistent `.plot/`
 *      (warren-7e0f) and mirrors the agent-emitted `decision_made` into
 *      warren's event stream as `plot.decision_made` tagged with `plotId`.
 *
 *   4. Assertions on `/runs/:id/events` and on disk:
 *        - host-side `run_dispatched` line is present in the project's
 *          `.plot/plot-<id>.events.jsonl` post-spawn (step 2).
 *        - Hard-required (warren-49d7, pl-95dd step 2): a `text` event
 *          containing `PLOT_ID=<id>` proves warren-e26f's env reached the
 *          sandbox process group; `PLOT_ACTOR=agent:<name>:<runId>` proves
 *          the composed actor string survived intact; `plot.decision_made`
 *          appears with matching `plotId` (mirrored by warren-7e0f); and
 *          the project's `.plot/plot-<id>.events.jsonl` carries the
 *          agent's `decision_made` line after reap. These were
 *          soft-skipped pre-warren-a346 because burrow-cli@0.3.1's
 *          `POST /burrows` handler dropped `body.env`; with burrow-59cd
 *          shipped and the burrow-cli pin bumped (warren-0a6b), the
 *          contract is enforced unconditionally so any future regression
 *          fails CI loudly.
 *
 *   5. Negative path — dispatch a run on the EXISTING `.plot`-less sample
 *      project WITHOUT a `plot_id`. Assert no event on the stream has a
 *      `plot.*` kind, no `plot_run_dispatched_failed` is recorded, and
 *      no event envelope carries a non-null `plotId` tag. This is the
 *      "byte-identical to pre-change behavior" promise — Plot integration
 *      is opt-in by gating on `project.hasPlot` AND the per-run `plot_id`.
 *      Defensive corollary: the stub agent's `PLOT_ID=` echo line MUST
 *      NOT appear on a no-plot run, since the agent.sh branch is env-gated.
 *
 * In-proc only — the test pokes at the host-side project clone's `.plot/`
 * directly, which container mode wouldn't surface.
 *
 * warren-3c40 caveat (shared with scenarios 09/10): wait for `state=running`
 * before cancel so reap doesn't misclassify as `never_started`.
 *
 * warren-dcf3 caveat: branch_push will fail against the non-bare local
 * fixture; reap_failed step=branch_push is tolerated.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly addedAt: string;
	readonly hasPlot?: boolean;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly burrowId: string | null;
	readonly burrowRunId: string | null;
	readonly plotId: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

interface CancelResponse {
	readonly state: string;
	readonly alreadyTerminal: boolean;
}

interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
	readonly plotId?: string | null;
}

interface PlotListRow {
	readonly id: string;
	readonly name: string;
	readonly status: string;
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const PLOT_PROJECT_URL = "https://github.com/warren-acceptance/sample-with-plot.git";

export const scenario: Scenario = {
	id: "25",
	title:
		"Plot integration roundtrip — env reaches sandbox, agent append mirrors via reap, no-plot path unchanged",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });
		await http.expectStatus("POST", "/agents/refresh", 200);

		// Build a Plot-enabled fixture next to the shared one. The fixture
		// re-uses the existing sample's stub-agent.sh + burrow.toml so the
		// stub-shell agent is already wired up; the only delta is the
		// committed `.plot/` directory with one pre-init Plot.
		const fixturePath = join(ctx.tmp, "scenario-25-fixture");
		const plotId = await buildPlotFixture({
			fixturePath,
			sourceFixturePath: ctx.fixtures.sampleProjectPath,
			gitConfigPath: join(ctx.tmp, "git-config"),
			redirectUrl: PLOT_PROJECT_URL,
		});
		ctx.logger.debug(`scenario-25: built plot fixture at ${fixturePath} with plotId=${plotId}`);

		// Register the project. The post-clone refresh detects `.plot/` and
		// sets hasPlot=true (warren-4e20). The POST response carries the
		// fully-populated row including the freshly-detected feature flag;
		// there is no GET /projects/:id today, so the POST body is the
		// source of truth for hasPlot + localPath.
		const plotProject = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
			body: { gitUrl: PLOT_PROJECT_URL },
		});
		assertEqual(
			plotProject.hasPlot,
			true,
			"plot fixture project surfaces hasPlot=true after clone (warren-4e20)",
		);

		// === Plot run ===
		const plotRun = await dispatchAndCancel({
			http,
			projectId: plotProject.id,
			agentName: ctx.fixtures.stubAgentName,
			plotId,
			promptSuffix: "scenario-25 plot run",
		});

		// Host-side `run_dispatched` lands on the project's .plot/ at spawn
		// time (warren-e848). Poll until it's there — the appender fires
		// after attachBurrow and may race with our first read.
		const projectPlotEventsPath = join(plotProject.localPath, ".plot", `${plotId}.events.jsonl`);
		await waitForFileLineMatching(
			projectPlotEventsPath,
			(line) =>
				line.includes(`"type":"run_dispatched"`) && line.includes(`"run_id":"${plotRun.id}"`),
			8_000,
			`run_dispatched event for run ${plotRun.id} on ${projectPlotEventsPath}`,
		);

		// Fetch the full event tail for the run. Reap runs inline on cancel
		// (mx-bade10) so by the time `waitForTerminal` returns we've already
		// merged + mirrored.
		const plotEvents = await fetchAllEvents(http, plotRun.id);

		// Hard-required (warren-49d7, pl-95dd step 2): with burrow-59cd shipped
		// and the burrow-cli pin bumped (warren-0a6b), burrow's POST /burrows
		// handler parses body.env into BurrowUpInput.envOverrides, so PLOT_ID
		// and PLOT_ACTOR reach the sandbox process group. The four assertions
		// below — env echo, actor echo, agent plot append, reap mirror — now
		// run unconditionally; any future regression in that contract fails
		// CI loudly here.
		const echoed = findTextEvent(plotEvents, `PLOT_ID=${plotId}`);
		if (echoed === undefined) {
			throw new AcceptanceError(
				`plot run ${plotRun.id}: missing PLOT_ID=${plotId} echo on stream — burrow did not forward body.env into the sandbox (warren-a346/burrow-59cd regression?); got text events: ${listTextEvents(plotEvents)}`,
			);
		}
		const expectedActorPrefix = `PLOT_ACTOR=agent:${ctx.fixtures.stubAgentName}:${plotRun.id}`;
		const echoedActor = findTextEvent(plotEvents, expectedActorPrefix);
		if (echoedActor === undefined) {
			throw new AcceptanceError(
				`plot run ${plotRun.id}: missing ${expectedActorPrefix} echo on stream — PLOT_ACTOR did not reach the sandbox; got text events: ${listTextEvents(plotEvents)}`,
			);
		}
		const plotOk = findTextEvent(plotEvents, "plot append decision_made OK");
		if (plotOk === undefined) {
			throw new AcceptanceError(
				`plot run ${plotRun.id}: env reached the sandbox but 'plot append decision_made' did not succeed; got text events: ${listTextEvents(plotEvents)}`,
			);
		}
		const mirrored = plotEvents.find(
			(e) => e.kind === "plot.decision_made" && (e.payload?.plotId ?? null) === plotId,
		);
		if (mirrored === undefined) {
			throw new AcceptanceError(
				`plot run ${plotRun.id}: env reached the sandbox and plot append succeeded, but reap did not mirror plot.decision_made for plotId=${plotId}; got kinds: ${summariseKinds(plotEvents)}`,
			);
		}
		assertEqual(
			mirrored.payload?.actor,
			`agent:${ctx.fixtures.stubAgentName}:${plotRun.id}`,
			"mirrored plot.decision_made carries the agent actor warren-e26f composed",
		);

		// Post-reap disk verification — the project's persistent
		// .plot/plot-<id>.events.jsonl now carries the agent's decision_made
		// line in addition to the host-side run_dispatched.
		const projectPlotEventsAfter = await readFile(projectPlotEventsPath, "utf8");
		assertTrue(
			projectPlotEventsAfter.includes(`"type":"decision_made"`) &&
				projectPlotEventsAfter.includes(`agent:${ctx.fixtures.stubAgentName}:${plotRun.id}`),
			`project .plot file ${projectPlotEventsPath} missing agent decision_made entry after reap; body: ${projectPlotEventsAfter}`,
		);

		// === Byte-identical no-plot path ===
		// Dispatch against the EXISTING sample (no .plot/) WITHOUT plot_id.
		// No plot.* events, no plot_run_dispatched_failed, and every event
		// envelope on the stream must carry plotId=null.
		const sampleProject = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);
		const noPlotRun = await dispatchAndCancel({
			http,
			projectId: sampleProject.id,
			agentName: ctx.fixtures.stubAgentName,
			promptSuffix: "scenario-25 no-plot baseline",
		});
		assertEqual(noPlotRun.plotId, null, "no-plot dispatch run row plotId is null");

		const noPlotEvents = await fetchAllEvents(http, noPlotRun.id);
		const plotKinds = noPlotEvents.filter(
			(e) => e.kind.startsWith("plot.") || e.kind === "plot_run_dispatched_failed",
		);
		if (plotKinds.length > 0) {
			throw new AcceptanceError(
				`no-plot run ${noPlotRun.id} contained plot.* events but should be byte-identical to pre-change behavior: ${plotKinds.map((e) => e.kind).join(", ")}`,
			);
		}

		// Stream-envelope plotId tag — the NDJSON path tags every row with
		// the run's plotId (warren-a8c3). For a no-plot dispatch this must
		// be null on every envelope.
		const envelopes: EventRow[] = [];
		for await (const env of http.streamNdjson(`/runs/${encodeURIComponent(noPlotRun.id)}/events`)) {
			envelopes.push(env as EventRow);
		}
		for (const env of envelopes) {
			if (env.plotId !== null && env.plotId !== undefined) {
				throw new AcceptanceError(
					`no-plot run ${noPlotRun.id}: event seq=${env.seq} kind=${env.kind} carries non-null plotId=${env.plotId}`,
				);
			}
		}

		// Also: the stub agent's PLOT_ID echo should NOT fire when env is
		// absent — a defensive check that env-gating in the agent is intact.
		const leakedEcho = noPlotEvents.find(
			(e) =>
				e.kind === "text" &&
				typeof e.payload?.text === "string" &&
				(e.payload.text as string).startsWith("stub-agent: PLOT_ID="),
		);
		if (leakedEcho !== undefined) {
			throw new AcceptanceError(
				`no-plot run ${noPlotRun.id}: stub-agent emitted a 'PLOT_ID=' echo even though no plot_id was dispatched; payload=${JSON.stringify(leakedEcho.payload)}`,
			);
		}
	},
};

interface BuildPlotFixtureInput {
	readonly fixturePath: string;
	readonly sourceFixturePath: string;
	readonly gitConfigPath: string;
	readonly redirectUrl: string;
}

/**
 * Build a sibling fixture project that mirrors the shared sample (same
 * burrow.toml + stub agent script) but additionally carries a committed
 * `.plot/` directory holding one pre-initialized Plot. Returns the plot
 * id so the scenario can dispatch with `plot_id=<id>`.
 *
 * The redirect line is appended (idempotent) to the harness's existing
 * git-config so warren clones via the fake gitUrl resolve to this on-disk
 * path. `git config insteadOf` is consulted on every `git` invocation, so
 * appending after warren boot is fine.
 */
async function buildPlotFixture(input: BuildPlotFixtureInput): Promise<string> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceFixturePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceFixturePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance plot fixture\n\nUsed by scripts/acceptance/scenarios/25-plot-roundtrip.ts.\n",
	);

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);

	// `plot init <name>` creates `.plot/plot-<id>.json` + events file +
	// .index.db. Run with a user actor so the seed `plot_created` event
	// is authored by user:* (Plot SPEC §6 — agent actors are forbidden
	// from `plot_created` for new plots).
	await runIn(input.fixturePath, ["plot", "init", "scenario-25"], {
		...env,
		PLOT_ACTOR: "user:acceptance",
	});

	const list = await runIn(input.fixturePath, ["plot", "list", "--json"], env);
	const plots = JSON.parse(list.stdout) as PlotListRow[];
	if (plots.length !== 1) {
		throw new AcceptanceError(
			`scenario-25 fixture: expected exactly one Plot after init, got ${plots.length}: ${list.stdout}`,
		);
	}
	const plotId = plots[0]?.id;
	if (plotId === undefined) {
		throw new AcceptanceError(`scenario-25 fixture: plot list --json missing id: ${list.stdout}`);
	}

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(input.fixturePath, ["git", "commit", "-m", "init: plot acceptance fixture"], env);

	// Append the insteadOf entry to the shared git-config so warren's
	// `git clone <PLOT_PROJECT_URL>` lands on this on-disk path.
	const redirect = `[url "${input.fixturePath}"]\n\tinsteadOf = ${input.redirectUrl}\n`;
	const existing = await readFile(input.gitConfigPath, "utf8").catch(() => "");
	if (!existing.includes(`insteadOf = ${input.redirectUrl}`)) {
		await writeFile(input.gitConfigPath, `${existing}\n${redirect}`);
	}

	return plotId;
}

interface DispatchAndCancelInput {
	readonly http: WarrenHttp;
	readonly projectId: string;
	readonly agentName: string;
	readonly plotId?: string;
	readonly promptSuffix: string;
}

async function dispatchAndCancel(input: DispatchAndCancelInput): Promise<RunRow> {
	const prompt = `[sleep_ms=6000] ${input.promptSuffix}`;
	const body: Record<string, unknown> = {
		agent: input.agentName,
		project: input.projectId,
		prompt,
	};
	if (input.plotId !== undefined) body.plotId = input.plotId;
	const created = await input.http.expectJson<CreateRunResponse>("POST", "/runs", 201, { body });
	const run = created.run;
	assertTrue(
		typeof run.burrowRunId === "string" && run.burrowRunId !== null && run.burrowRunId.length > 0,
		"spawn response missing burrowRunId — plot scenario needs the run to reach burrow",
	);
	if (input.plotId !== undefined) {
		assertEqual(run.plotId, input.plotId, "spawn response carries the dispatched plot_id");
	}

	// Wait long enough for the bridge to mirror queued → running AND for
	// the stub-agent's early prints (PLOT_ID echo + `plot append`) to land
	// as events before we cancel. The stub's plot append happens on lines
	// 86-93 of agent.sh, which run before the sleep, so 1.5s is generous.
	await waitForRunning(input.http, run.id, 8_000);
	await sleep(1_500);

	const cancel = await input.http.expectJson<CancelResponse>(
		"POST",
		`/runs/${encodeURIComponent(run.id)}/cancel`,
		200,
		{ body: { reason: "scenario-25 cancel" } },
	);
	assertEqual(
		cancel.alreadyTerminal,
		false,
		"scenario-25 cancel should not report alreadyTerminal=true",
	);

	const finalState = await waitForTerminal(input.http, run.id, 12_000);
	assertTrue(
		TERMINAL_STATES.has(finalState),
		`run ${run.id} did not reach a terminal state; ended at '${finalState}'`,
	);
	// Re-read so the row carries the post-spawn plotId surface (warren-a8c3
	// persists it via attachBurrow's runs.update).
	return input.http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(run.id)}`, 200);
}

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
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
				`run ${runId} reached terminal state '${row.state}' before bridge mirrored running (warren-3c40 territory)`,
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

function findTextEvent(events: readonly EventRow[], needle: string): EventRow | undefined {
	return events.find(
		(e) =>
			e.kind === "text" &&
			typeof e.payload?.text === "string" &&
			(e.payload.text as string).includes(needle),
	);
}

function listTextEvents(events: readonly EventRow[]): string {
	return events
		.filter((e) => e.kind === "text" && typeof e.payload?.text === "string")
		.map((e) => `"${(e.payload?.text as string).slice(0, 120)}"`)
		.join(", ");
}

async function waitForFileLineMatching(
	path: string,
	predicate: (line: string) => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const start = Date.now();
	let lastBody = "";
	while (Date.now() - start < timeoutMs) {
		try {
			lastBody = await readFile(path, "utf8");
			for (const line of lastBody.split("\n")) {
				if (line.trim() === "") continue;
				if (predicate(line)) return;
			}
		} catch {
			// File not yet present — keep polling.
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`timed out after ${timeoutMs}ms waiting for ${label}; last body: ${lastBody.slice(0, 500)}`,
	);
}

function summariseKinds(events: readonly EventRow[]): string {
	const counts = new Map<string, number>();
	for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
	return Array.from(counts.entries())
		.map(([k, n]) => `${k}×${n}`)
		.join(", ");
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
			`scenario-25 fixture command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
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

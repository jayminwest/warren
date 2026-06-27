/**
 * Helper group for scenario 28 (`28-plot-list-and-create.ts`), split
 * out under the Article II file-size burn-down (warren-acf2, pl-437c
 * step 1). Holds the row/response interfaces, fixture constants, and
 * the fixture-build / dispatch helpers the scenario chains together;
 * the scenario body itself stays in the sibling file.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";

export interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly hasPlot?: boolean;
}

export interface PlotSummary {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly intent_goal_preview: string;
	readonly attachments_count: number;
	readonly last_event_ts: string;
	readonly last_event_actor: string;
	readonly project_id: string;
}

export interface PlotListResponse {
	readonly plots: readonly PlotSummary[];
}

export interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly burrowRunId: string | null;
	readonly plotId: string | null;
}

export interface CreateRunResponse {
	readonly run: RunRow;
}

export interface CancelResponse {
	readonly state: string;
	readonly alreadyTerminal: boolean;
}

export interface PlotsByCliRow {
	readonly id: string;
	readonly name: string;
	readonly status: string;
}

export interface EventEnvelope {
	readonly kind: string;
	readonly seq: number;
	readonly plotId?: string | null;
}

export interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

export const PLOT_PROJECT_A_URL = "https://github.com/warren-acceptance/sample-plots-a.git";
export const PLOT_PROJECT_B_URL = "https://github.com/warren-acceptance/sample-plots-b.git";

export const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

export interface BuildPlotFixtureInput {
	readonly fixturePath: string;
	readonly sourceFixturePath: string;
	readonly gitConfigPath: string;
	readonly redirectUrl: string;
	readonly plotName: string;
	readonly finalStatus: "drafting" | "ready" | "active";
}

/**
 * Build a sibling fixture mirroring the shared sample (burrow.toml +
 * stub agent) plus a committed `.plot/` directory holding one Plot
 * pre-transitioned to `finalStatus`. Returns the plot id.
 *
 * Idempotent: a re-run on an existing fixture path replays only the
 * insteadOf redirect append, leaving the on-disk git repo untouched.
 * That keeps the scenario re-runnable against a long-lived deployment
 * without piling on Plots inside the fixture itself; the Plot the
 * scenario _creates_ (assertion 3) lands in warren's project clone,
 * not the fixture.
 */
export async function buildPlotFixture(input: BuildPlotFixtureInput): Promise<string> {
	const env = withGitIdentity();

	if (existsSync(join(input.fixturePath, ".git"))) {
		await appendInsteadOf(input.gitConfigPath, input.fixturePath, input.redirectUrl);
		const list = await runIn(input.fixturePath, ["plot", "list", "--json"], env);
		const plots = JSON.parse(list.stdout) as PlotsByCliRow[];
		const id = plots[0]?.id;
		if (id === undefined) {
			throw new AcceptanceError(
				`scenario-28 fixture ${input.fixturePath}: existing clone missing a Plot: ${list.stdout}`,
			);
		}
		return id;
	}

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
		"# warren acceptance plots fixture\n\nUsed by scripts/acceptance/scenarios/28-plot-list-and-create.ts.\n",
	);

	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);

	const plotEnv: Record<string, string> = { ...env, PLOT_ACTOR: "user:acceptance" };
	await runIn(input.fixturePath, ["plot", "init", input.plotName], plotEnv);
	const list = await runIn(input.fixturePath, ["plot", "list", "--json"], env);
	const plots = JSON.parse(list.stdout) as PlotsByCliRow[];
	if (plots.length !== 1) {
		throw new AcceptanceError(
			`scenario-28 fixture: expected exactly one Plot after init, got ${plots.length}: ${list.stdout}`,
		);
	}
	const plotId = plots[0]?.id;
	if (plotId === undefined) {
		throw new AcceptanceError(`scenario-28 fixture: plot list --json missing id: ${list.stdout}`);
	}

	if (input.finalStatus === "ready" || input.finalStatus === "active") {
		await runIn(input.fixturePath, ["plot", "status", plotId, "ready"], plotEnv);
	}
	if (input.finalStatus === "active") {
		await runIn(input.fixturePath, ["plot", "status", plotId, "active"], plotEnv);
	}

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(input.fixturePath, ["git", "commit", "-m", "init: plots acceptance fixture"], env);

	await appendInsteadOf(input.gitConfigPath, input.fixturePath, input.redirectUrl);
	return plotId;
}

export async function appendInsteadOf(
	gitConfigPath: string,
	fixturePath: string,
	redirectUrl: string,
): Promise<void> {
	const redirect = `[url "${fixturePath}"]\n\tinsteadOf = ${redirectUrl}\n`;
	const existing = await readFile(gitConfigPath, "utf8").catch(() => "");
	if (existing.includes(`insteadOf = ${redirectUrl}`)) return;
	await writeFile(gitConfigPath, `${existing}\n${redirect}`);
}

export async function ensurePlotProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

export async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

export interface DispatchAndCancelInput {
	readonly http: WarrenHttp;
	readonly projectId: string;
	readonly agentName: string;
	readonly promptSuffix: string;
}

export async function dispatchAndCancel(input: DispatchAndCancelInput): Promise<RunRow> {
	const prompt = `[sleep_ms=4000] ${input.promptSuffix}`;
	const created = await input.http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
		body: { agent: input.agentName, project: input.projectId, prompt },
	});
	const run = created.run;
	assertTrue(
		typeof run.burrowRunId === "string" && run.burrowRunId !== null && run.burrowRunId.length > 0,
		"spawn response missing burrowRunId — scenario-28 baseline needs the run to reach burrow",
	);

	await waitForRunning(input.http, run.id, 8_000);
	const cancel = await input.http.expectJson<CancelResponse>(
		"POST",
		`/runs/${encodeURIComponent(run.id)}/cancel`,
		200,
		{ body: { reason: "scenario-28 cancel" } },
	);
	assertEqual(cancel.alreadyTerminal, false, "scenario-28 cancel should not be alreadyTerminal");

	const finalState = await waitForTerminal(input.http, run.id, 12_000);
	assertTrue(
		TERMINAL_STATES.has(finalState),
		`run ${run.id} did not reach a terminal state; ended at '${finalState}'`,
	);
	return input.http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(run.id)}`, 200);
}

export async function waitForRunning(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<void> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (row.state === "running") return;
		if (TERMINAL_STATES.has(row.state)) {
			throw new AcceptanceError(
				`run ${runId} reached terminal '${row.state}' before bridge mirrored running (warren-3c40)`,
			);
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach 'running' within ${timeoutMs}ms (last=${last})`,
	);
}

export async function waitForTerminal(
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
		`run ${runId} did not reach a terminal state within ${timeoutMs}ms (last=${last})`,
	);
}

export interface RunResult {
	stdout: string;
	stderr: string;
}

export async function runIn(
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
			`scenario-28 fixture command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
		);
	}
	return { stdout, stderr };
}

export function withGitIdentity(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

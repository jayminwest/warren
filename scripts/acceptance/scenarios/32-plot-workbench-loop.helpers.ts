import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";

export interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly plotId: string | null;
	readonly mode?: string;
	readonly pausedAt?: string | null;
	readonly pausedQuestionEventId?: string | null;
}

export const SEED_TS = "2026-05-18T00:00:00.000Z";
export const SEED_ID = "ah-acc32-aaaa";
export const POLL_INTERVAL_MS = 250;

export interface BuildFixtureInput {
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
export async function buildFixture(input: BuildFixtureInput): Promise<void> {
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

export async function waitForRunState(
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

export async function waitForRunStateNot(
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

export async function waitForRunTerminal(
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
export async function appendPlotQuestion(input: AppendPlotQuestionInput): Promise<void> {
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

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

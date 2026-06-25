/**
 * File-local helper group for scenario 26 (`26-plan-run-roundtrip.ts`).
 *
 * Mirrors the precedent in `20-preview.helpers.ts` (warren-65f6) and
 * `32-plot-workbench-loop.helpers.ts`: the row/response wire shapes,
 * module constants, fixture builder, seed/plan row writers, source-seed
 * rewrite, plan-state polling, and event fetch live here so the
 * scenario body stays under the per-file line budget. The scenario body
 * imports the exported symbols back.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";

export interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly hasSeeds?: boolean;
}

export interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly trigger: string;
	readonly prUrl: string | null;
}

export interface PlanRunRow {
	readonly id: string;
	readonly planId: string;
	readonly projectId: string;
	readonly agentName: string;
	readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
}

export interface PlanRunChildRow {
	readonly planRunId: string;
	readonly seq: number;
	readonly seedId: string;
	readonly runId: string | null;
	readonly state:
		| "pending"
		| "dispatched"
		| "running"
		| "pr_open"
		| "merged"
		| "failed"
		| "skipped";
}

export interface CreatePlanRunResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
}

export interface PlanRunDetailResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
	readonly runs: readonly RunRow[];
}

export interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
}

export const PLAN_PROJECT_URL = "https://github.com/warren-acceptance/sample-plan-run.git";
export const PLAN_ID = "pl-acc-26";
export const SEED_A = "ah-acc-26-a";
export const SEED_B = "ah-acc-26-b";
export const SEED_C = "ah-acc-26-c";
export const SEED_TS = "2026-05-15T00:00:00.000Z";

export const TERMINAL_PLAN_STATES = new Set(["succeeded", "failed", "cancelled"]);
export const PLAN_DEADLINE_MS = 90_000;
export const POLL_INTERVAL_MS = 500;

export interface BuildPlanRunFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	/** The shared harness git-config — its canopy + sample insteadOf entries get copied across. */
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly projectGitUrl: string;
}

/**
 * Stand up a sibling fixture project mirroring the shared sample (same
 * burrow.toml + stub agent) plus committed `.seeds/{config.yaml,
 * issues.jsonl, plans.jsonl}` rows the API handler + coordinator read
 * on dispatch. Also writes a minimal git-config with an `insteadOf`
 * rewrite for PLAN_PROJECT_URL → fixturePath so warren's POST /projects
 * clone lands locally.
 */
export async function buildPlanRunFixture(input: BuildPlanRunFixtureInput): Promise<void> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	// claude-code stub is the agent scenario 26 dispatches against — raw-text
	// stub-shell never emits a runtime-terminal envelope, so the bridge
	// would never finalize the child runs. The claude-stub emits a `result`
	// envelope that warren's `detectRuntimeTerminal` recognizes, letting
	// reap fire inline and the coordinator advance.
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance plan-run fixture\n\nUsed by scripts/acceptance/scenarios/26-plan-run-roundtrip.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-plan-run"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		[seedRowOpen(SEED_A), seedRowOpen(SEED_B), seedRowOpen(SEED_C)].join(""),
	);
	await writeFile(join(input.fixturePath, ".seeds", "plans.jsonl"), planRow());

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);
	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(input.fixturePath, ["git", "commit", "-m", "init: plan-run acceptance fixture"], env);

	const harnessConfig = existsSync(input.harnessGitConfigPath)
		? await readFile(input.harnessGitConfigPath, "utf8")
		: "";
	const lines: string[] = [
		harnessConfig.trimEnd(),
		`[url "${input.fixturePath}"]`,
		`\tinsteadOf = ${input.projectGitUrl}`,
		"",
	];
	await writeFile(input.gitConfigPath, `${lines.join("\n")}\n`);
}

export function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-26 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

export function seedRowClosed(id: string): string {
	const row = {
		id,
		title: `scenario-26 ${id}`,
		status: "closed",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: "2026-05-16T00:00:00.000Z",
	};
	return `${JSON.stringify(row)}\n`;
}

export function planRow(): string {
	const plan = {
		id: PLAN_ID,
		seed: "warren-acc-26",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: "scenario-26 acceptance plan",
			approach: "dispatch three child seeds via the plan-run coordinator",
			steps: [
				{ title: `close ${SEED_A}` },
				{ title: `close ${SEED_B}` },
				{ title: `close ${SEED_C}` },
			],
		},
		children: [SEED_A, SEED_B, SEED_C],
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: "scenario-26 plan-run roundtrip",
	};
	return `${JSON.stringify(plan)}\n`;
}

export async function rewriteSourceSeedClosed(fixturePath: string, seedId: string): Promise<void> {
	const seedsFile = join(fixturePath, ".seeds", "issues.jsonl");
	const body = existsSync(seedsFile) ? await readFile(seedsFile, "utf8") : "";
	const lines = body.split("\n").filter((l) => l.trim() !== "");
	const rewritten = lines.map((l) => {
		try {
			const parsed = JSON.parse(l) as { id?: unknown };
			if (typeof parsed.id === "string" && parsed.id === seedId) {
				return seedRowClosed(seedId).trim();
			}
		} catch {
			// keep unparseable rows as-is
		}
		return l;
	});
	await writeFile(seedsFile, `${rewritten.join("\n")}\n`);
	const env = withGitIdentity();
	await runIn(fixturePath, ["git", "add", "-A"], env);
	await runIn(
		fixturePath,
		["git", "commit", "-m", `scenario-26: close ${seedId} out of band`],
		env,
	);
}

export async function waitForPlanState(
	http: WarrenHttp,
	planRunId: string,
	target: string,
	timeoutMs: number,
): Promise<PlanRunDetailResponse> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<PlanRunDetailResponse>(
			"GET",
			`/plan-runs/${encodeURIComponent(planRunId)}`,
			200,
		);
		last = row.planRun.state;
		if (row.planRun.state === target) return row;
		if (TERMINAL_PLAN_STATES.has(row.planRun.state)) {
			throw new AcceptanceError(
				`plan-run ${planRunId}: expected '${target}', reached terminal '${row.planRun.state}'`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`plan-run ${planRunId} did not reach '${target}' within ${timeoutMs}ms (last state=${last})`,
	);
}

export async function fetchAllPlanRunEvents(
	http: WarrenHttp,
	planRunId: string,
): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/plan-runs/${encodeURIComponent(planRunId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
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
			`scenario-26 command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
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

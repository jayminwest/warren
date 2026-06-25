import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcceptanceError } from "../../lib/assert.ts";
import { runIn, withGitIdentity } from "./git-helpers.ts";

export const PLOTTED_PROJECT_URL =
	"https://github.com/warren-acceptance/sample-plot-plan-run-synth.git";
export const BARE_PROJECT_URL =
	"https://github.com/warren-acceptance/sample-plot-plan-run-synth-bare.git";

// Pre-committed seeds in the plotted fixture. SEED_C is wired into
// WARREN_STUB_NO_COMMIT_SEEDS so its dispatch drives the trivial-merge
// branch (reap commitsAhead=0 → child → merged without GH polling).
export const SEED_A = "ah-acc31-aaaa";
export const SEED_B = "ah-acc31-bbbb";
export const SEED_C = "ah-acc31-cccc";
export const SEED_CLOSED = "ah-acc31-zzzz";
export const SD_PLAN_REF = "pl-acc31-other";
export const SEED_TS = "2026-05-18T00:00:00.000Z";

export interface BuildPlottedFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
}

export interface BuildPlottedFixtureResult {
	readonly happyPlotId: string;
	readonly emptyPlotId: string;
}

/**
 * Build the `.seeds/`-and-`.plot/`-enabled fixture. Two Plots:
 *   - happy: 3 open seeds_issue + 1 closed seeds_issue + 1 sd_plan-
 *     shaped seeds_issue attached. Three are dispatchable after
 *     filtering; the 4th (closed) and 5th (`pl-*` ref) drop out.
 *   - empty: 1 closed seeds_issue + 1 sd_plan-shaped seeds_issue —
 *     both filtered, leaving zero candidates so the synthesis handler
 *     surfaces NoDispatchableSeedsError.
 */
export async function buildPlottedFixture(
	input: BuildPlottedFixtureInput,
): Promise<BuildPlottedFixtureResult> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });

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
		"# warren acceptance plot-plan-run synthesis fixture\n\nUsed by scripts/acceptance/scenarios/31-plot-plan-run-synthesis.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-plot-plan-run-synth"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		[
			seedRowOpen(SEED_A),
			seedRowOpen(SEED_B),
			seedRowOpen(SEED_C),
			seedRowClosed(SEED_CLOSED),
		].join(""),
	);
	// Pre-seed `.seeds/plans.jsonl` empty — the synthesizer appends to
	// it at POST time. sd plan show would reject a non-existent file,
	// but `sd plan submit` creates it idempotently.
	await writeFile(join(input.fixturePath, ".seeds", "plans.jsonl"), "");

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);

	const plotEnv: Record<string, string> = { ...env, PLOT_ACTOR: "user:acceptance" };

	// Happy Plot: 3 open + 1 closed + 1 sd_plan-shaped attachments. Left at
	// `ready`: POST /plot-plan-runs promotes it `ready` → `active` at dispatch
	// (promotePlotToActiveOnDispatch, warren-dfff), then auto-done flips it to
	// `done` — exercising the full promotion chain.
	await runIn(input.fixturePath, ["plot", "init", "scenario-31-happy"], plotEnv);
	const happyList = await runIn(input.fixturePath, ["plot", "list", "--json"], plotEnv);
	const happyPlots = JSON.parse(happyList.stdout) as ReadonlyArray<{ id: string }>;
	const happyPlotId = happyPlots[0]?.id;
	if (happyPlotId === undefined) {
		throw new AcceptanceError(
			`scenario-31 fixture: happy plot init missing id (${happyList.stdout})`,
		);
	}
	await runIn(input.fixturePath, ["plot", "status", happyPlotId, "ready"], plotEnv);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SEED_A}`, "--role", "primary"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SEED_B}`, "--role", "primary"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SEED_C}`, "--role", "primary"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SEED_CLOSED}`, "--role", "context"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SD_PLAN_REF}`, "--role", "context"],
		plotEnv,
	);

	// Empty-candidates Plot — both attachments will be filtered.
	await runIn(input.fixturePath, ["plot", "init", "scenario-31-empty"], plotEnv);
	const allList = await runIn(input.fixturePath, ["plot", "list", "--json"], plotEnv);
	const allPlots = JSON.parse(allList.stdout) as ReadonlyArray<{ id: string }>;
	const emptyPlotId = allPlots.map((p) => p.id).find((id) => id !== happyPlotId);
	if (emptyPlotId === undefined) {
		throw new AcceptanceError(
			`scenario-31 fixture: empty plot init missing distinct id (${allList.stdout})`,
		);
	}
	await runIn(input.fixturePath, ["plot", "status", emptyPlotId, "ready"], plotEnv);
	await runIn(input.fixturePath, ["plot", "status", emptyPlotId, "active"], plotEnv);
	await runIn(
		input.fixturePath,
		["plot", "attach", emptyPlotId, `seeds_issue:${SEED_CLOSED}`, "--role", "context"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", emptyPlotId, `seeds_issue:${SD_PLAN_REF}`, "--role", "context"],
		plotEnv,
	);

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: plot-plan-run synthesis acceptance fixture"],
		env,
	);

	return { happyPlotId, emptyPlotId };
}

export interface BuildBareFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
}

/**
 * Bare fixture: a project clone with no `.plot/` and no `.seeds/`.
 * Used to exercise the `project_lacks_plot` arm — the
 * `hasPlot` gate fires before the seeds-cli reachability check.
 */
export async function buildBareFixture(input: BuildBareFixtureInput): Promise<void> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });

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
		"# warren acceptance plot-plan-run synthesis bare fixture\n\nUsed by scripts/acceptance/scenarios/31-plot-plan-run-synthesis.ts (project_lacks_plot arm).\n",
	);

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);
	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(input.fixturePath, ["git", "commit", "-m", "init: bare plot-plan-run fixture"], env);
}

export interface GitConfigEntry {
	readonly harnessGitConfigPath?: string;
	readonly fakeUrl?: string;
	readonly localPath?: string;
}

/**
 * Write a layered git-config: append the harness's existing
 * insteadOf rules (so cn/sd clones still resolve), then append
 * fresh insteadOf rules for each fixture URL → local path mapping.
 */
export async function writeGitConfigRedirects(
	configPath: string,
	entries: readonly GitConfigEntry[],
): Promise<void> {
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.harnessGitConfigPath !== undefined) {
			if (existsSync(entry.harnessGitConfigPath)) {
				const body = await readFile(entry.harnessGitConfigPath, "utf8");
				out.push(body.trimEnd());
			}
			continue;
		}
		if (entry.fakeUrl !== undefined && entry.localPath !== undefined) {
			out.push(`[url "${entry.localPath}"]`);
			out.push(`\tinsteadOf = ${entry.fakeUrl}`);
		}
	}
	out.push("");
	await writeFile(configPath, `${out.join("\n")}\n`);
}

function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-31 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

function seedRowClosed(id: string): string {
	const row = {
		id,
		title: `scenario-31 ${id}`,
		status: "closed",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		closedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError } from "../../lib/assert.ts";
import { runIn, withGitIdentity } from "./git-helpers.ts";

export const PLAN_PROJECT_URL = "https://github.com/warren-acceptance/sample-plan-run-plot.git";
export const PLAN_ID_PLOT = "pl-acc-27-plot";
export const PLAN_ID_BASE = "pl-acc-27-base";
export const SEED_A = "ah-acc-27-a";
export const SEED_B = "ah-acc-27-b";
export const SEED_C = "ah-acc-27-c";
export const SEED_D = "ah-acc-27-d";
export const SEED_TS = "2026-05-17T00:00:00.000Z";

export interface BuildPlanRunPlotFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly projectGitUrl: string;
}

/**
 * Build a fixture mirroring scenario 26's `.seeds/`-enabled layout plus a
 * committed `.plot/` directory holding one Plot pre-transitioned to
 * `ready`. The scenario asserts dispatch promotes it `ready` → `active`,
 * then the final child merge flips it `active` → `done`. Returns the plot
 * id so the scenario can dispatch with it.
 *
 * Two plans land in `.seeds/plans.jsonl` so the scenario can hit both
 * dispatch shapes against the same project without re-cloning.
 */
export async function buildPlanRunPlotFixture(
	input: BuildPlanRunPlotFixtureInput,
): Promise<string> {
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
		"# warren acceptance plan-run + plot fixture\n\nUsed by scripts/acceptance/scenarios/27-plan-run-plot-roundtrip.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-plan-run-plot"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		[seedRowOpen(SEED_A), seedRowOpen(SEED_B), seedRowOpen(SEED_C), seedRowOpen(SEED_D)].join(""),
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "plans.jsonl"),
		[planRow(PLAN_ID_PLOT, [SEED_A, SEED_B, SEED_C]), planRow(PLAN_ID_BASE, [SEED_D])].join(""),
	);

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);

	// `plot init` with a user actor (Plot SPEC §6 forbids agent actors on
	// plot_created). Then transition drafting → ready and STOP: dispatch
	// itself promotes `ready` → `active` (promotePlotToActiveOnDispatch,
	// warren-dfff), and the coordinator's auto-done flips `active` → `done`.
	// Leaving the Plot at `ready` exercises the full promotion chain rather
	// than pre-seeding `active`.
	const plotEnv: Record<string, string> = { ...env, PLOT_ACTOR: "user:acceptance" };
	await runIn(input.fixturePath, ["plot", "init", "scenario-27"], plotEnv);
	const list = await runIn(input.fixturePath, ["plot", "list", "--json"], plotEnv);
	const plots = JSON.parse(list.stdout) as ReadonlyArray<{ id: string }>;
	if (plots.length !== 1) {
		throw new AcceptanceError(
			`scenario-27 fixture: expected exactly one Plot after init, got ${plots.length}: ${list.stdout}`,
		);
	}
	const plotId = plots[0]?.id;
	if (plotId === undefined) {
		throw new AcceptanceError(`scenario-27 fixture: plot list --json missing id: ${list.stdout}`);
	}
	await runIn(input.fixturePath, ["plot", "status", plotId, "ready"], plotEnv);

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: plan-run + plot acceptance fixture"],
		env,
	);

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

	return plotId;
}

function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-27 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

function planRow(id: string, children: readonly string[]): string {
	const plan = {
		id,
		seed: "warren-acc-27",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: `scenario-27 acceptance plan ${id}`,
			approach: "dispatch child seeds via the plan-run coordinator",
			steps: children.map((s) => ({ title: `close ${s}` })),
		},
		children,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: `scenario-27 ${id}`,
	};
	return `${JSON.stringify(plan)}\n`;
}

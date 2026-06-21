/**
 * Scenario 36 — ready-to-dispatch plans roundtrip (pl-3fc4 step 8 / warren-f16c).
 *
 * Closes the loop the per-step unit tests open for the "ready to
 * dispatch" operator surface (warren-9d6f): warren-34df adds the
 * `listDispatchedPlanIds` dedup primitive, warren-6807 the
 * `listSeedStatuses` reader, warren-6e2a the pure `computeReadyPlans`
 * helper, warren-f716 the `GET /projects/:id/ready-plans` handler,
 * warren-7937 the typed client facades, and warren-585d / warren-ce62
 * the UI. This scenario chains the read endpoint + dispatch through a
 * real warren+burrow stack against a `.seeds/`-enabled fixture.
 *
 * Topology mirrors scenario 26 (closest twin): an in-proc warren+burrow
 * pair against a bespoke fixture committed under a per-scenario tmp root,
 * with `WARREN_GH_FETCH_OVERRIDE=merged` so the dispatched plan-run's
 * single child merges through the stubbed GH path without a real fixture.
 *
 * The fixture commits real `.seeds/{config.yaml, issues.jsonl, plans.jsonl}`
 * rows: one `approved` plan (pl-acc-36) with exactly one open child
 * (ah-acc-36-a). The assertions:
 *
 *   1. POST /projects clones the fixture → hasSeeds=true.
 *   2. GET /projects/:id/ready-plans surfaces pl-acc-36 with
 *      openChildCount=1 (approved + has-open-child + not-dispatched).
 *   3. POST /plan-runs dispatches the plan.
 *   4. GET /projects/:id/ready-plans no longer surfaces pl-acc-36
 *      (dedup via listDispatchedPlanIds confirmed).
 *
 * In-proc only: drives source-repo edits the container harness doesn't
 * bind-mount (matches scenario 26 / mx-1d31f0 posture).
 */

import { existsSync } from "node:fs";
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
}

interface ReadyPlanRow {
	readonly id: string;
	readonly name?: string;
	readonly status: string;
	readonly openChildCount: number;
}

interface ReadyPlansResponse {
	readonly plans: readonly ReadyPlanRow[];
}

interface PlanRunRow {
	readonly id: string;
	readonly planId: string;
	readonly projectId: string;
	readonly agentName: string;
	readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
}

interface CreatePlanRunResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly { readonly seedId: string }[];
}

const PLAN_PROJECT_URL = "https://github.com/warren-acceptance/sample-ready-plans.git";
const PLAN_ID = "pl-acc-36";
const SEED_A = "ah-acc-36-a";
const SEED_TS = "2026-05-15T00:00:00.000Z";

export const scenario: Scenario = {
	id: "36",
	title:
		"Ready-to-dispatch plans roundtrip — approved plan with one open child surfaces in ready-plans (openChildCount=1), then drops out after a plan-run dispatch (dedup confirmed)",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-36-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		await buildReadyPlansFixture({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
			projectGitUrl: PLAN_PROJECT_URL,
		});

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_STUB_SLEEP_MS: "0",
					// Stub every GitHub REST call so the dispatched plan-run's
					// single child merges through the canned `merged` shape.
					WARREN_GH_FETCH_OVERRIDE: "merged",
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			ctx.logger.info(`scenario-36: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PLAN_PROJECT_URL },
			});
			assertEqual(
				project.hasSeeds,
				true,
				"ready-plans fixture project surfaces hasSeeds=true after clone",
			);
			const readyPlansPath = `/projects/${encodeURIComponent(project.id)}/ready-plans`;

			// === Before dispatch: the approved+open plan is ready ===
			const before = await http.expectJson<ReadyPlansResponse>("GET", readyPlansPath, 200);
			const readyBefore = before.plans.find((p) => p.id === PLAN_ID);
			if (readyBefore === undefined) {
				throw new AcceptanceError(
					`before dispatch: ready-plans missing ${PLAN_ID}; saw [${before.plans
						.map((p) => p.id)
						.join(", ")}]`,
				);
			}
			assertEqual(
				readyBefore.status,
				"approved",
				`before dispatch: ${PLAN_ID} surfaces with status='approved'`,
			);
			assertEqual(
				readyBefore.openChildCount,
				1,
				`before dispatch: ${PLAN_ID} surfaces with openChildCount=1`,
			);

			// === Dispatch the plan-run ===
			const created = await http.expectJson<CreatePlanRunResponse>("POST", "/plan-runs", 201, {
				body: {
					project: project.id,
					planId: PLAN_ID,
					agent: "claude-code",
					promptTemplate: "closeseed {seed_id}",
				},
			});
			assertEqual(created.planRun.planId, PLAN_ID, "dispatch: plan-run is linked to the plan id");
			assertEqual(created.children.length, 1, "dispatch: one child row created for the open seed");

			// === After dispatch: the plan is deduped out of ready-plans ===
			const after = await http.expectJson<ReadyPlansResponse>("GET", readyPlansPath, 200);
			assertTrue(
				after.plans.every((p) => p.id !== PLAN_ID),
				`after dispatch: ${PLAN_ID} no longer appears in ready-plans (dedup via listDispatchedPlanIds)`,
			);
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};

interface BuildReadyPlansFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	/** The shared harness git-config — its canopy + sample insteadOf entries get copied across. */
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly projectGitUrl: string;
}

/**
 * Stand up a sibling fixture project mirroring the shared sample (same
 * burrow.toml + stub agents) plus committed `.seeds/{config.yaml,
 * issues.jsonl, plans.jsonl}` rows: one approved plan with a single open
 * child. Also writes a minimal git-config with an `insteadOf` rewrite for
 * PLAN_PROJECT_URL → fixturePath so warren's POST /projects clone lands
 * locally.
 */
async function buildReadyPlansFixture(input: BuildReadyPlansFixtureInput): Promise<void> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	// claude-code stub is the agent this scenario dispatches against — it
	// emits a `result` envelope warren's detectRuntimeTerminal recognizes
	// so the dispatched child run finalizes cleanly.
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance ready-plans fixture\n\nUsed by scripts/acceptance/scenarios/36-ready-to-dispatch-plans.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-ready-plans"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(join(input.fixturePath, ".seeds", "issues.jsonl"), seedRowOpen(SEED_A));
	await writeFile(join(input.fixturePath, ".seeds", "plans.jsonl"), planRow());

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);
	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: ready-plans acceptance fixture"],
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
}

function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-36 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

function planRow(): string {
	const plan = {
		id: PLAN_ID,
		seed: "warren-acc-36",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: "scenario-36 acceptance plan",
			approach: "dispatch one child seed via the plan-run coordinator",
			steps: [{ title: `close ${SEED_A}` }],
		},
		children: [SEED_A],
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: "scenario-36 ready-to-dispatch plan",
	};
	return `${JSON.stringify(plan)}\n`;
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
			`scenario-36 command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
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

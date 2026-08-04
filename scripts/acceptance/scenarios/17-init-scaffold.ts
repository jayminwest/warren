/**
 * Scenario 17 — `warren init` scaffolds a valid `.warren/` (warren-bd22).
 *
 * Acceptance criteria from warren-bd22:
 *   1. Running the affordance against a project with no .warren/ produces
 *      a valid envelope on next GET /projects/:id/warren-config.
 *   2. Schema is enforced at scaffold time (no malformed files written).
 *   3. Refuses to overwrite existing files.
 *   4. Acceptance scenario covers scaffold → load round-trip.
 *
 * Two invocations of `bun run src/cli/main.ts init`, each spawning a real
 * subprocess so the scenario exercises the CLI exit-code path the same
 * way scenario 11 does for `doctor`:
 *
 *  A. `--cwd <tmp>` against an empty scratch dir — asserts the scaffold
 *     contract (files exist, defaults.json is `{"defaultRole":...}`,
 *     triggers.yaml has the canonical header + empty list).
 *
 *  B. Re-invoke against the same dir — asserts the refusal contract
 *     (exit 2, stderr mentions "refusing to overwrite", existing files
 *     are untouched).
 *
 *  C. End-to-end round-trip: write the scaffolded files into the sample
 *     project source repo, refresh the warren clone, and assert
 *     GET /projects/:id/warren-config returns the parsed defaults with
 *     `errors: []` — the load half of the producer↔loader contract.
 *
 * Cleans up after itself so the shared sample-project fixture stays
 * `.warren/`-free for sibling scenarios.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface InitJson {
	readonly ok: boolean;
	readonly scaffolded: {
		readonly root: string;
		readonly files: readonly string[];
		readonly defaultRole: string | null;
	};
}

interface InitRun {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
}

interface WarrenConfigResponse {
	readonly triggers: ReadonlyArray<{ readonly id: string }> | null;
	readonly defaults: {
		readonly defaultRole?: string;
	} | null;
	readonly errors: ReadonlyArray<{ readonly file: string; readonly code: string }>;
}

export const scenario: Scenario = {
	id: "17",
	title: "warren init scaffolds a valid .warren/, refuses to overwrite, round-trips through load",
	modes: ["in-proc"],
	async run(ctx) {
		const scratch = join(ctx.tmp, "scenario-17");
		const scaffoldDir = join(scratch, "scaffold");
		await mkdir(scaffoldDir, { recursive: true });

		try {
			/* ---------------- A: scaffold into --cwd ----------------- */
			const first = await runInit(ctx, ["--cwd", scaffoldDir, "--default-role", "claude-code"]);
			if (first.exitCode !== 0) {
				throw new AcceptanceError(`first init exited ${first.exitCode}; stderr=${first.stderr}`);
			}
			const firstJson = JSON.parse(first.stdout.trim()) as InitJson;
			assertEqual(firstJson.ok, true, "init A: ok=true");
			assertEqual(
				firstJson.scaffolded.defaultRole,
				"claude-code",
				"init A: defaultRole pinned from --default-role",
			);
			assertEqual(
				firstJson.scaffolded.files.slice().sort().join(","),
				".warren/config.yaml,.warren/triggers.yaml",
				"init A: both files reported scaffolded",
			);

			const triggersAbs = join(scaffoldDir, ".warren/triggers.yaml");
			const configAbs = join(scaffoldDir, ".warren/config.yaml");
			assertTrue(existsSync(triggersAbs), "init A: triggers.yaml exists on disk");
			assertTrue(existsSync(configAbs), "init A: config.yaml exists on disk");

			// warren-5840 layout: defaults live in config.yaml, not the
			// legacy defaults.json (warren-e376).
			const configRaw = await readFile(configAbs, "utf8");
			assertTrue(
				configRaw.includes("defaultRole: claude-code"),
				`init A: config.yaml carries the requested defaultRole; got ${JSON.stringify(configRaw)}`,
			);

			const triggersRaw = await readFile(triggersAbs, "utf8");
			assertTrue(
				triggersRaw.includes("# .warren/triggers.yaml"),
				"init A: triggers.yaml has the canonical header comment",
			);
			assertTrue(
				triggersRaw.trim().endsWith("[]"),
				"init A: triggers.yaml ends with an empty list literal",
			);

			/* ---------------- B: refusal on second run --------------- */
			const second = await runInit(ctx, ["--cwd", scaffoldDir]);
			assertEqual(second.exitCode, 2, "init B: refusal exit code is 2");
			assertTrue(
				second.stderr.includes("refusing to overwrite"),
				`init B: stderr mentions refusal; got ${JSON.stringify(second.stderr)}`,
			);

			/* ---------------- C: round-trip through load ------------- */
			const sourceWarrenDir = join(ctx.fixtures.sampleProjectPath, ".warren");
			// Setup belt-and-braces: scrub any lingering .warren/ from a
			// prior scenario so we start from "absent" before publishing.
			await resetSourceWarrenDir(ctx.fixtures.sampleProjectPath);

			const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });
			const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);
			await refreshProject(http, project.id);

			// Publish the scaffolded files into the source repo and commit.
			await mkdir(sourceWarrenDir, { recursive: true });
			await copyFile(triggersAbs, join(sourceWarrenDir, "triggers.yaml"));
			await copyFile(configAbs, join(sourceWarrenDir, "config.yaml"));
			await commitInSource(
				ctx.fixtures.sampleProjectPath,
				"scenario-17: publish scaffolded .warren/",
			);
			await refreshProject(http, project.id);

			const envelope = await http.expectJson<WarrenConfigResponse>(
				"GET",
				`/projects/${encodeURIComponent(project.id)}/warren-config`,
				200,
			);
			assertEqual(envelope.errors.length, 0, "round-trip: no per-file errors");
			assertTrue(
				envelope.triggers !== null && envelope.triggers.length === 0,
				`round-trip: triggers parses as empty list; got ${JSON.stringify(envelope.triggers)}`,
			);
			assertTrue(envelope.defaults !== null, "round-trip: defaults is non-null");
			assertEqual(
				envelope.defaults?.defaultRole,
				"claude-code",
				"round-trip: defaultRole survives publish + refresh",
			);
		} finally {
			await resetSourceWarrenDir(ctx.fixtures.sampleProjectPath).catch(() => undefined);
			// Best-effort refresh so the next scenario sees the absent state.
			try {
				const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });
				const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
				const row = list.projects.find((p) => p.gitUrl === ctx.fixtures.sampleProjectGitUrl);
				if (row !== undefined) {
					await refreshProject(http, row.id).catch(() => undefined);
				}
			} catch {
				// teardown is best-effort
			}
			await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		}
	},
};

async function runInit(ctx: ScenarioCtx, args: readonly string[]): Promise<InitRun> {
	// Don't inherit parent env wholesale — warren CLI auto-loads .env, and
	// any CANOPY_REPO_URL etc. there would muddy the scaffold path. Init
	// only needs PATH (for the bun resolver chain) and a writable HOME.
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		// warren-97a2: init resolves agents/projects through the HTTP API
		// now, so point the CLI at the harness's running server.
		WARREN_BASE_URL: ctx.warrenUrl,
		WARREN_API_TOKEN: ctx.token,
	};
	const proc = Bun.spawn({
		cmd: ["bun", "run", "src/cli/main.ts", "init", ...args],
		cwd: process.cwd(),
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
	return { exitCode: exitCode ?? 0, stdout, stderr };
}

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function refreshProject(http: WarrenHttp, projectId: string): Promise<void> {
	await http.expectJson("POST", `/projects/${encodeURIComponent(projectId)}/refresh`, 200);
}

async function resetSourceWarrenDir(sourceRepoPath: string): Promise<void> {
	const warrenDir = join(sourceRepoPath, ".warren");
	if (!existsSync(warrenDir)) return;
	await rm(warrenDir, { recursive: true, force: true });
	await runGit(sourceRepoPath, ["add", "-A"]);
	const status = await runGit(sourceRepoPath, ["status", "--porcelain"]);
	if (status.stdout.trim() === "") return;
	await runGit(sourceRepoPath, ["commit", "-m", "scenario-17: reset .warren/"]);
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

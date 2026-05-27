import { join } from "node:path";
import type { EventRow } from "../../db/schema.ts";
import type { ReapExec, ReapFs } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Plot commit-through-reap (warren-343a, shape (a))                         */
/* ----------------------------------------------------------------------- */

/**
 * Filenames matching this prefix are gitignored derived state per
 * ../plot/README.md — the SQLite index Plot rebuilds on demand. Skipping
 * these on copy mirrors the snapshot/restore wrapper in
 * src/projects/refresh.ts (mx-239786) and keeps the warren-authored
 * commit free of churn.
 */
const PLOT_INDEX_SKIP_PREFIX = ".index.db";

interface StagePlotForCommitInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Replicate every committable `.plot/` file from the project clone into
 * the burrow workspace, then stage `.plot/` and author a
 * `chore(warren): plot state` commit when there's a real delta the agent
 * never committed. Returns true when a warren-identity commit landed.
 *
 * The project clone is the union point: by this step `mergePlot` has
 * already merged the workspace's agent-side `.plot/` writes into the
 * project clone, and the project clone also carries any host-side
 * appender writes (`defaultPlotAppender`, `defaultPlanRunPlotAppender`,
 * `autoTransitionPlotToDone`) that warren wrote at dispatch / plan-run
 * coordination time. Copying that union back into the workspace gives
 * `git push` a single canonical view to ship to origin.
 *
 * `.plot/.index.db*` files are skipped — derived SQLite state Plot
 * rebuilds via `plot rebuild-index` (mx-239786). Anything that isn't
 * `plot-*.json` or `plot-*.events.jsonl` is also skipped: the SPEC §11.O
 * file layout for `.plot/` is flat and these two extensions cover the
 * full carrier surface; filtering keeps stray dotfiles out of the warren
 * commit.
 *
 * `git add .plot/` honors a project-level `.gitignore` of `.plot/` — a
 * project that gitignored the directory has opted out of committing
 * Plot state, and the staged-changes check below sees no entries.
 */
export async function stagePlotForCommit(input: StagePlotForCommitInput): Promise<boolean> {
	const { workspacePath, projectPath, fs, exec, emit } = input;
	const projectPlotDir = join(projectPath, ".plot");
	const workspacePlotDir = join(workspacePath, ".plot");

	const entries = await fs.readdir(projectPlotDir);
	let copied = 0;
	for (const name of entries) {
		if (name.startsWith(PLOT_INDEX_SKIP_PREFIX)) continue;
		if (!name.startsWith("plot-")) continue;
		if (!name.endsWith(".json") && !name.endsWith(".events.jsonl")) continue;
		const contents = await fs.readFile(join(projectPlotDir, name));
		if (contents === null) continue;
		if (copied === 0) await fs.mkdirp(workspacePlotDir);
		await fs.writeFile(join(workspacePlotDir, name), contents);
		copied += 1;
	}
	if (copied === 0) return false;

	await exec.run("git", ["add", "--", ".plot/"], {
		cwd: workspacePath,
		timeoutMs: 10_000,
	});

	// `git diff --cached --quiet -- .plot/` exits non-zero when there are
	// staged changes under .plot/ — the natural primitive for "did the
	// add actually pick up a delta the agent hadn't already committed".
	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ".plot/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}
	if (!hasStagedDelta) return false;

	await exec.run(
		"git",
		[
			"-c",
			"user.name=warren",
			"-c",
			"user.email=warren@os-eco.dev",
			"commit",
			"-m",
			"chore(warren): plot state",
		],
		{ cwd: workspacePath, timeoutMs: 10_000 },
	);
	await emit("reap.plot_committed", {
		message: "chore(warren): plot state",
		filesStaged: copied,
	});
	return true;
}

/* ----------------------------------------------------------------------- */
/* Seeds commit-through-reap (warren-7ecc)                                   */
/* ----------------------------------------------------------------------- */

/**
 * Seeds-tracker files committed by warren on the agent's behalf. The
 * SPEC for `.seeds/` (../seeds/SPEC.md) pins a flat layout of two
 * jsonl carriers — `issues.jsonl` (the issue queue) and `plans.jsonl`
 * (sd plan submit output, the planner's primary write). `config.yaml`
 * and `templates.jsonl` are committed by the human at `sd init` time
 * and don't get rewritten by agent activity, so excluding them keeps
 * the warren-authored commit narrow.
 */
const SEEDS_COMMITTABLE_FILES: readonly string[] = ["issues.jsonl", "plans.jsonl"];

interface StageSeedsForCommitInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Replicate `.seeds/issues.jsonl` + `.seeds/plans.jsonl` from the
 * project clone into the burrow workspace, stage `.seeds/`, and author
 * a `chore(warren): seeds state` commit when there's a real delta the
 * agent never committed. Returns true when a warren-identity commit
 * landed.
 *
 * The carrier shape mirrors stagePlotForCommit (warren-343a) — agents
 * with narrowly-scoped write contracts (planner, see
 * src/registry/builtins/planner.ts) are forbidden from running
 * `git commit`. The planner's `sd plan submit` writes
 * `.seeds/issues.jsonl` + `.seeds/plans.jsonl` inside the workspace;
 * without this step the push exits zero, lands no work, and reap fires
 * `reap.empty_push`. The project clone is the union point: by this
 * step `mirrorSeeds` has already merged closed-status rows and
 * newly-created rows from the workspace back into the project's
 * `issues.jsonl`. Copying the union back into the workspace gives
 * `git push` a single canonical view to ship to origin.
 *
 * `git add .seeds/` honors a project-level `.gitignore` of `.seeds/`
 * — a project that gitignored the directory has opted out of
 * committing seeds state, and the staged-changes check below sees no
 * entries.
 */
export async function stageSeedsForCommit(input: StageSeedsForCommitInput): Promise<boolean> {
	const { workspacePath, projectPath, fs, exec, emit } = input;
	const projectSeedsDir = join(projectPath, ".seeds");
	const workspaceSeedsDir = join(workspacePath, ".seeds");

	let copied = 0;
	for (const name of SEEDS_COMMITTABLE_FILES) {
		const contents = await fs.readFile(join(projectSeedsDir, name));
		if (contents === null) continue;
		if (copied === 0) await fs.mkdirp(workspaceSeedsDir);
		await fs.writeFile(join(workspaceSeedsDir, name), contents);
		copied += 1;
	}
	if (copied === 0) return false;

	await exec.run("git", ["add", "--", ".seeds/"], {
		cwd: workspacePath,
		timeoutMs: 10_000,
	});

	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ".seeds/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}
	if (!hasStagedDelta) return false;

	await exec.run(
		"git",
		[
			"-c",
			"user.name=warren",
			"-c",
			"user.email=warren@os-eco.dev",
			"commit",
			"-m",
			"chore(warren): seeds state",
		],
		{ cwd: workspacePath, timeoutMs: 10_000 },
	);
	await emit("reap.seeds_committed", {
		message: "chore(warren): seeds state",
		filesStaged: copied,
	});
	return true;
}

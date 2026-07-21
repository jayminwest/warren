import { join } from "node:path";
import {
	gitRepoContextScrubEnv,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "../../bot-identity.ts";
import type { EventRow } from "../../db/schema.ts";
import type { ReapExec, ReapFs } from "./types.ts";

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
 * Agents with narrowly-scoped write contracts (planner, see
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

	// warren-23dd: scrub the inherited repo-context GIT_* on every git call in
	// this flow (mirrors clone-apply.ts) so a leaked
	// GIT_DIR / GIT_INDEX_FILE can't divert the add/diff/commit out of
	// `workspacePath` into the parent repo.
	await exec.run("git", ["add", "--", ".seeds/"], {
		cwd: workspacePath,
		timeoutMs: 10_000,
		env: gitRepoContextScrubEnv(),
	});

	// warren-be12 (#420): narrow the staged-delta guard to the two
	// committable carriers (symmetry with the `--only` pathspecs below) so
	// an unrelated pre-staged file under `.seeds/` can't spoof a delta.
	const seedsPathspecs = SEEDS_COMMITTABLE_FILES.map((name) => join(".seeds", name));
	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ...seedsPathspecs], {
			cwd: workspacePath,
			timeoutMs: 10_000,
			env: gitRepoContextScrubEnv(),
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}
	if (!hasStagedDelta) return false;

	await exec.run(
		"git",
		[
			...warrenCommitIdentityArgs(),
			"commit",
			// warren-27d3: skip project git hooks for warren's bookkeeping commit.
			"--no-verify",
			// warren-be12 (#420): path-limit the commit to the two seeds
			// carriers via `--only` so pre-staged unrelated files are not
			// swept into the warren bookkeeping commit.
			"--only",
			"-m",
			"chore(warren): seeds state",
			"--",
			...seedsPathspecs,
		],
		// warren-035c: pin the bot identity in env too so an inherited
		// GIT_AUTHOR_*/GIT_COMMITTER_* can't out-rank the `-c user.*` config.
		// warren-23dd: scrub the inherited repo-context GIT_* so the commit
		// can't escape `workspacePath`; identity wins over the scrub.
		{
			cwd: workspacePath,
			timeoutMs: 10_000,
			env: { ...gitRepoContextScrubEnv(), ...warrenCommitIdentityEnv() },
		},
	);
	await emit("reap.seeds_committed", {
		message: "chore(warren): seeds state",
		filesStaged: copied,
	});
	return true;
}

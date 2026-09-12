/**
 * Keep warren's per-run files out of the run branch (warren-194a, #1239).
 *
 * The pi harness writes its transcript under `.pi/sessions/`, warren seeds
 * `.warren/agent.json`, and `writeWorkspaceGitconfig` drops
 * `.gitconfig.burrow`, all inside the worktree. In warren's own repo those
 * paths are gitignored; in a mirror of somebody else's repo they are not, so
 * a broad agent commit (`git add -A`) sweeps them into the pull request.
 *
 * Git excludes are local to a checkout and never reach the remote, which is
 * the property this needs. Where they live depends on how the workspace was
 * materialized:
 *
 *   - Worktree off a host clone: `.git/info/exclude` is a COMMON path, shared
 *     by every worktree of the clone, so a per-run list written there races
 *     with the sibling runs and outlives the run on the operator's clone. The
 *     per-worktree mechanism git offers is `core.excludesFile` set with
 *     `git config --worktree`, which lands in `.git/worktrees/<id>/config.worktree`
 *     and dies with the worktree. It needs `extensions.worktreeConfig` on the
 *     shared repo, which this module turns on. The pattern file itself sits in
 *     the same per-worktree admin dir, so `git worktree remove` cleans it up.
 *   - Fresh clone (local fallback, K8s init container): the clone owns its
 *     `.git`, so `.git/info/exclude` is isolated by construction and a managed
 *     block appended there is enough.
 *
 * The list stays narrow on purpose. `harnessStatePrefixes()` is the wrong
 * source: it feeds reap's dirty-path classifier, where a broad prefix such as
 * `.claude/` is harmless, but as a git exclude that prefix would silently drop
 * real files the agent created under a tracked directory. Each adapter
 * declares its own `commitExcludes` instead. Warren's seed drops
 * (`.pi/skills/`, `.pi/prompts/`, `.seeds/workflow.txt`) are deliberately not
 * here: the `seed_reset` finalize stage owns them, and it relies on `git clean`
 * seeing them, which an exclude would prevent.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { commitExcludes } from "../../runtime/adapters/index.ts";
import { runGitOrThrow } from "./exec.ts";
import { WORKSPACE_GITCONFIG_FILENAME } from "./identity.ts";

/**
 * Where warren seeds the rendered agent envelope. `src/runs/seed.ts` builds
 * the drop from this constant so the exclude and the seed cannot drift apart.
 */
export const AGENT_ENVELOPE_PATH = ".warren/agent.json";

/** Name of the per-worktree pattern file, kept beside `config.worktree`. */
const WORKTREE_EXCLUDE_FILENAME = "warren.exclude";

const BLOCK_START = "# >>> warren run excludes >>>";
const BLOCK_END = "# <<< warren run excludes <<<";

/**
 * Every workspace-relative pattern a run branch must never carry: the
 * harness transcripts each adapter declares, the seeded agent envelope, and
 * the workspace gitconfig. De-duplicated, stable order.
 */
export function workspaceCommitExcludes(): readonly string[] {
	return [...new Set([...commitExcludes(), AGENT_ENVELOPE_PATH, WORKSPACE_GITCONFIG_FILENAME])];
}

/** The managed block, one pattern per line, terminated by a newline. */
export function renderExcludeBlock(patterns: readonly string[]): string {
	return `${[BLOCK_START, ...patterns, BLOCK_END].join("\n")}\n`;
}

export interface InstallWorkspaceExcludesOptions {
	workspacePath: string;
	/** How the workspace was materialized; decides where the excludes live. */
	kind: "worktree" | "clone";
	patterns?: readonly string[];
}

/**
 * Install the run excludes for a freshly materialized workspace. Idempotent:
 * running it twice on the same workspace writes the same bytes and config.
 */
export async function installWorkspaceExcludes(
	opts: InstallWorkspaceExcludesOptions,
): Promise<void> {
	const patterns = opts.patterns ?? workspaceCommitExcludes();
	if (opts.kind === "worktree") {
		await installWorktreeExcludes(opts.workspacePath, patterns);
		return;
	}
	const target = await gitPath(opts.workspacePath, "info/exclude");
	await appendManagedBlock(target, patterns);
}

/**
 * Append the managed block to a clone's `.git/info/exclude` through an
 * injectable fs, for callers that cannot spawn git or touch the real disk in
 * tests (the K8s init container). `existing` is the file's current contents,
 * or `undefined` when it does not exist yet.
 */
export function mergeExcludeBlock(
	existing: string | undefined,
	patterns: readonly string[],
): string {
	const block = renderExcludeBlock(patterns);
	const current = existing ?? "";
	if (current.includes(block)) return current;
	const stripped = stripManagedBlock(current);
	const separator = stripped.length === 0 || stripped.endsWith("\n") ? "" : "\n";
	return `${stripped}${separator}${block}`;
}

async function installWorktreeExcludes(
	workspacePath: string,
	patterns: readonly string[],
): Promise<void> {
	// Per-worktree config is refused until the shared repo opts in. Setting it
	// from inside the worktree writes the COMMON config, which is the one git
	// consults for extensions.
	await runGitOrThrow(["config", "extensions.worktreeConfig", "true"], { cwd: workspacePath });
	// An unknown name under --git-path resolves to the per-worktree admin dir
	// (`.git/worktrees/<id>/`), unlike `info/exclude`, which is a common path.
	const target = await gitPath(workspacePath, WORKTREE_EXCLUDE_FILENAME);
	await writeFile(target, renderExcludeBlock(patterns));
	await runGitOrThrow(["config", "--worktree", "core.excludesFile", target], {
		cwd: workspacePath,
	});
}

async function appendManagedBlock(target: string, patterns: readonly string[]): Promise<void> {
	let existing: string | undefined;
	try {
		existing = await readFile(target, "utf8");
	} catch {
		existing = undefined;
	}
	const merged = mergeExcludeBlock(existing, patterns);
	if (merged === existing) return;
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, merged);
}

function stripManagedBlock(text: string): string {
	const start = text.indexOf(BLOCK_START);
	if (start === -1) return text;
	const endMarker = text.indexOf(BLOCK_END, start);
	if (endMarker === -1) return text;
	const end = endMarker + BLOCK_END.length;
	const rest = text.slice(end).replace(/^\n/, "");
	return `${text.slice(0, start)}${rest}`;
}

/**
 * Resolve a path inside the checkout's own git dir. For a worktree that is
 * `.git/worktrees/<id>/…` (the admin dir git removes with the worktree); for
 * a clone it is `.git/…`. Always absolute, so the value is safe to store in
 * config regardless of the cwd git later runs from.
 */
async function gitPath(workspacePath: string, rel: string): Promise<string> {
	const res = await runGitOrThrow(["rev-parse", "--path-format=absolute", "--git-path", rel], {
		cwd: workspacePath,
	});
	return res.stdout.trim();
}

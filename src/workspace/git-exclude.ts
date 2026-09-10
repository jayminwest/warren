/**
 * Managed `.git/info/exclude` block for warren-owned workspace state (warren-194a).
 *
 * The harness writes its scratch inside the worktree (pi pins
 * `.pi/sessions/`, claude-code `.claude/`), and warren's own seed drops land
 * beside it (`.warren/agent.json` and friends, `buildSeedFiles`). A target
 * repository whose `.gitignore` does not cover those paths lets the agent's
 * own `git add` sweep them into the run branch, and they ride into the pull
 * request. Warren's repo happens to ignore them; a mirror of someone else's
 * does not.
 *
 * git resolves `info/exclude` as a COMMON path: every worktree of a clone
 * reads the same file, and `git rev-parse --git-path info/exclude` returns
 * that shared file rather than a per-worktree copy. A file written to
 * `.git/worktrees/<name>/info/exclude` is not read at all (verified on git
 * 2.43.0), so the shared file is the only exclude a worktree honors.
 *
 * The write therefore reaches the host clone, which is why it is confined to a
 * marked block and rewritten in full each time: every run renders the same
 * bytes, so two runs materializing against one project converge instead of
 * racing, and an operator can see and delete exactly what warren added.
 * Excludes are local to a checkout and never reach the remote, which is the
 * property this fix needs.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { WorkspaceMaterializationError } from "./errors.ts";
import { runGit } from "./git/exec.ts";

export const EXCLUDE_BLOCK_START = "# >>> warren managed >>>";
export const EXCLUDE_BLOCK_END = "# <<< warren managed <<<";

export type ExcludeGitRunner = (
	args: string[],
	opts?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Filesystem seam, shaped to match the K8s init container's `InitFs` so the
 * pod path can hand its injectable fs straight in. `rename` is optional
 * because that seam does not carry one: with it we swap the file in atomically,
 * without it we write in place. The pod materializes a fresh per-run clone
 * nobody else reads, so the in-place write is safe there.
 */
export interface ExcludeFs {
	mkdir: (path: string, opts: { recursive: true }) => Promise<unknown>;
	readFile: (path: string) => Promise<string>;
	writeFile: (path: string, data: Uint8Array) => Promise<void>;
	rename?: (from: string, to: string) => Promise<void>;
}

export interface WriteExcludeDeps {
	git?: ExcludeGitRunner;
	fs?: ExcludeFs;
}

const defaultGit: ExcludeGitRunner = (args, opts) => runGit(args, opts ?? {});

const defaultFs: ExcludeFs = {
	mkdir: (path, opts) => mkdir(path, opts),
	readFile: (path) => readFile(path, "utf8"),
	writeFile: (path, data) => writeFile(path, data),
	rename: (from, to) => rename(from, to),
};

/**
 * Normalize the caller's patterns: drop blanks, collapse duplicates, keep the
 * caller's order. Adapters and seed builders both hand us plain workspace
 * paths, and the two lists overlap (`.pi/` shows up in each), so dedupe is not
 * cosmetic.
 */
function normalizePatterns(patterns: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const raw of patterns) {
		const pattern = raw.trim();
		if (pattern === "" || pattern.startsWith("#")) continue;
		seen.add(pattern);
	}
	return [...seen];
}

/**
 * Render `existing` with warren's block replaced by `patterns`, leaving every
 * other line untouched. An empty pattern list removes the block, so a caller
 * that stops excluding leaves nothing behind.
 *
 * Pure so the block algebra is testable without a git repository.
 */
export function renderManagedExclude(existing: string, patterns: readonly string[]): string {
	const lines = existing.split("\n");
	const start = lines.indexOf(EXCLUDE_BLOCK_START);
	const end = lines.indexOf(EXCLUDE_BLOCK_END);
	const managed = start !== -1 && end > start;
	const before = managed ? lines.slice(0, start) : lines;
	const after = managed ? lines.slice(end + 1) : [];

	const kept = [...before, ...after].join("\n").replace(/\n+$/, "");
	const normalized = normalizePatterns(patterns);
	if (normalized.length === 0) return kept === "" ? "" : `${kept}\n`;

	const block = [EXCLUDE_BLOCK_START, ...normalized, EXCLUDE_BLOCK_END].join("\n");
	return kept === "" ? `${block}\n` : `${kept}\n${block}\n`;
}

/**
 * Resolve the exclude file git actually reads for `workspaceRoot`.
 *
 * `--git-path` answers relative to the invocation cwd when the workspace is a
 * plain clone (`.git/info/exclude`) and absolute for a worktree, so join the
 * relative form onto the workspace rather than assuming either shape.
 */
async function resolveExcludePath(workspaceRoot: string, git: ExcludeGitRunner): Promise<string> {
	const res = await git(["rev-parse", "--git-path", "info/exclude"], { cwd: workspaceRoot });
	if (res.exitCode !== 0) {
		throw new WorkspaceMaterializationError(
			`git rev-parse --git-path info/exclude failed (exit ${res.exitCode}): ${
				res.stderr.trim() || res.stdout.trim()
			}`,
			{
				recoveryHint:
					"The workspace is not a git repository yet. Seed excludes after the worktree or clone exists.",
			},
		);
	}
	const raw = res.stdout.trim();
	if (raw === "") {
		throw new WorkspaceMaterializationError(
			"git rev-parse --git-path info/exclude returned an empty path",
		);
	}
	return isAbsolute(raw) ? raw : join(workspaceRoot, raw);
}

/**
 * Write warren's managed exclude block into the workspace's exclude file.
 *
 * Writes through a temp file in the same directory and renames, so a reader
 * never sees a half-written exclude and a concurrent writer cannot interleave
 * lines. Both runs render identical bytes, so last-write-wins is the correct
 * outcome rather than a lost update.
 */
export async function writeWorkspaceExcludes(
	workspaceRoot: string,
	patterns: readonly string[],
	deps: WriteExcludeDeps = {},
): Promise<void> {
	const git = deps.git ?? defaultGit;
	const fs = deps.fs ?? defaultFs;

	const excludePath = await resolveExcludePath(workspaceRoot, git);
	const existing = await fs.readFile(excludePath).catch(() => "");
	const next = renderManagedExclude(existing, patterns);
	if (next === existing) return;

	await fs.mkdir(dirname(excludePath), { recursive: true });
	const data = new TextEncoder().encode(next);
	if (fs.rename === undefined) {
		await fs.writeFile(excludePath, data);
		return;
	}
	const tmpPath = `${excludePath}.warren-${process.pid}.tmp`;
	await fs.writeFile(tmpPath, data);
	await fs.rename(tmpPath, excludePath);
}

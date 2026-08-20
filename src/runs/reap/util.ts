import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { RunRow, RunTerminalState } from "../../db/schema.ts";
import { resolveSpawnEnv } from "../../projects/clone.ts";
import { harnessStatePrefixes } from "../../runtime/adapters/index.ts";
import { WORKSPACE_GITCONFIG_FILENAME } from "../../workspace/git/identity.ts";
import type { ReapExec, ReapFs, ReapRunResult } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * The no-op `ReapRunResult` returned when `reapRun` is invoked against a
 * row that is already terminal (idempotent re-reap). Preserves the
 * already-persisted preview lifecycle (`live`/`failed`) and PR url; every
 * sub-step counter reports zero because no work was done.
 */
export function buildAlreadyTerminalResult(run: RunRow): ReapRunResult {
	const idempotentPreviewState =
		run.previewState === "live" || run.previewState === "failed" ? run.previewState : null;
	return {
		state: run.state as RunTerminalState,
		failureReason: run.failureReason,
		providerError: null,
		mulchUpdated: 0,
		mulchSkipped: 0,
		mulchAppended: 0,
		seedsClosed: 0,
		seedsCreated: 0,
		seedsCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		prUrl: run.prUrl,
		previewState: idempotentPreviewState,
		previewPort: run.previewPort,
		previewUrl: null,
		autoPlanRunCreated: false,
		autoPlanRunId: null,
		autoPlanRunPlanId: null,
		workspaceDestroyed: false,
		// warren-cd3b: surface any salvage a prior reap captured so an idempotent
		// re-reap still reports the recovery location.
		salvageRescueRef: run.salvageRef,
		salvagePath: run.salvagePath,
		errors: [],
		alreadyTerminal: true,
	};
}

export function splitLines(body: string): string[] {
	const out: string[] = [];
	for (const raw of body.split("\n")) {
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		out.push(trimmed);
	}
	return out;
}

export function createSeqAllocator(start: number): { next: () => number } {
	let cur = start;
	return {
		next: () => {
			cur += 1;
			return cur;
		},
	};
}

function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

export const defaultFs: ReapFs = {
	mkdirp: async (path) => {
		await mkdir(path, { recursive: true });
	},
	readFile: async (path) => {
		try {
			return await readFile(path, "utf8");
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	},
	writeFile: async (path, contents) => {
		await writeFile(path, contents);
	},
	readdir: async (path) => {
		try {
			return await readdir(path);
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	},
};

/**
 * Probe whether the workspace tree has uncommitted changes (warren-72b9).
 * Used by the empty-push path to tell a dropped commit (dirty tree + zero
 * commits ahead = agent staged work but never `git commit`-ed) apart from
 * a deliberate no-op (clean tree). `git status --porcelain` failures
 * resolve to `false` so a probe error degrades to the no-op shape rather
 * than crying wolf.
 */
export async function isWorkspaceDirty(exec: ReapExec, workspacePath: string): Promise<boolean> {
	try {
		const status = await exec.run("git", ["status", "--porcelain"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		return status.stdout.trim() !== "";
	} catch {
		return false;
	}
}

/**
 * Return the workspace-relative paths of every uncommitted change
 * (warren-89b0). Parses `git status --porcelain` — each line is
 * `XY <path>` (or `XY <old> -> <new>` for renames) — into the set of
 * touched paths so the domain can classify a zero-commit dirty tree as an
 * intentional bookkeeping-only no-op vs. a genuinely dropped commit. A
 * probe error resolves to `[]` (the clean shape) so it degrades to the
 * no-op posture rather than crying wolf, mirroring {@link isWorkspaceDirty}.
 */
export async function workspaceDirtyPaths(
	exec: ReapExec,
	workspacePath: string,
): Promise<string[]> {
	try {
		const status = await exec.run("git", ["status", "--porcelain"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		return parseDirtyPaths(status.stdout);
	} catch {
		return [];
	}
}

/** Parse `git status --porcelain` stdout into workspace-relative paths. */
export function parseDirtyPaths(porcelain: string): string[] {
	const out: string[] = [];
	for (const raw of porcelain.split("\n")) {
		if (raw.trim() === "") continue;
		// Porcelain v1: 2 status chars + a space, then the path. Renames/copies
		// render `old -> new`; the destination is what's dirty in the tree.
		const rest = raw.slice(3);
		const arrow = rest.indexOf(" -> ");
		out.push((arrow >= 0 ? rest.slice(arrow + 4) : rest).trim());
	}
	return out;
}

/**
 * warren-managed data-plane directories (warren-89b0). Uncommitted changes
 * confined to these are NOT lost agent work: warren mirrors + commits them on
 * the agent's behalf during finalize (`.mulch/`, `.seeds/`). The per-run agent
 * envelope (`.warren/agent.json`) is gitignored (warren-5585), so it never
 * surfaces as a dirty tracked path. A zero-commit push whose ONLY dirty paths
 * are bookkeeping artifacts is a deliberate no-op, not a dropped commit.
 */
export const BOOKKEEPING_ARTIFACT_PREFIXES: readonly string[] = [".mulch/", ".seeds/"];

/**
 * Harness-owned scratch state (warren-f6f2). A third category, distinct from
 * {@link BOOKKEEPING_ARTIFACT_PREFIXES}: warren does NOT commit these on the
 * agent's behalf — the agent harness itself writes them into the workspace at
 * runtime (e.g. the claude-code harness drops `.claude/settings.local.json`).
 * The agent never staged them, so a zero-commit push whose only dirty paths
 * are harness scratch is a deliberate no-op, not a dropped commit. Kept as its
 * own constant rather than overloading the bookkeeping list, because the reason
 * they are ignorable is different (harness-written, not warren-committed).
 *
 * warren-c80e: the membership now comes from the adapter registry rather than
 * a literal here, so a new runtime declares its own scratch dirs beside the
 * rest of its per-harness facts. Reap classifies a workspace without knowing
 * which harness produced it, so this is the union across every adapter — the
 * same scope the flat literal had.
 */
export const HARNESS_STATE_PREFIXES: readonly string[] = harnessStatePrefixes();

/**
 * Warren-written runtime files that are neither committed on the agent's behalf
 * nor owned by any specific harness (warren-8dc8). A fourth category, distinct
 * from {@link BOOKKEEPING_ARTIFACT_PREFIXES} (warren commits those) and
 * {@link HARNESS_STATE_PREFIXES} (harness-written, per-adapter). These paths
 * are written by warren's runtime infrastructure for every run regardless of
 * which harness is used. `.gitconfig.burrow` is the canonical example:
 * `writeWorkspaceGitconfig` drops it so git inside the sandbox picks up the
 * workspace identity — it is never staged or committed. Import
 * {@link WORKSPACE_GITCONFIG_FILENAME} rather than re-spelling the literal;
 * warren-598f closed a nine-spelling drift by routing through one resolver.
 */
export const WARREN_RUNTIME_SCRATCH: readonly string[] = [WORKSPACE_GITCONFIG_FILENAME];

/**
 * Prefixes whose dirty paths are never lost agent work: warren-committed
 * bookkeeping artifacts, harness-owned scratch state, and warren-written
 * runtime files.
 */
const IGNORABLE_DIRTY_PREFIXES: readonly string[] = [
	...BOOKKEEPING_ARTIFACT_PREFIXES,
	...HARNESS_STATE_PREFIXES,
	...WARREN_RUNTIME_SCRATCH,
];

/**
 * The remote-tracking ref finalize must resolve BEFORE `branch_push` to count
 * `commits_ahead` on a ref-dispatch repair run, or `null` when the plain
 * `baseBranch..HEAD` range is the right one (warren-ba08, #979 / #994).
 *
 * On a repair run the push branch IS the base branch (`branch === baseBranch`,
 * warren-709e): workspace init checks the target branch out directly and
 * skips the per-run carve, so HEAD is attached to `baseBranch` and
 * `rev-list --count baseBranch..HEAD` is empty by construction — whether the
 * agent landed 0 commits or 10. The only ref still holding the pre-run tip is
 * `origin/<baseBranch>`, and `git push origin HEAD:<baseBranch>` rewrites it
 * on success, so the caller must `rev-parse` it before the push and count
 * against the resolved SHA after.
 */
export function repairBaseTrackingRef(branch: string, baseBranch: string): string | null {
	return branch !== "" && branch === baseBranch ? `origin/${baseBranch}` : null;
}

/**
 * True when the dirty tree is non-empty AND every dirty path lives under a
 * bookkeeping ({@link BOOKKEEPING_ARTIFACT_PREFIXES}) or harness-state
 * ({@link HARNESS_STATE_PREFIXES}) directory (warren-89b0, warren-f6f2). An
 * empty list returns false — a clean tree is already the classic
 * deliberate-no-op shape and never reached the dropped-commit branch.
 * Conservative by construction: a single dirty path outside those categories
 * (real uncommitted work) fails the check and keeps the dropped-commit guard
 * armed.
 */
export function isBookkeepingOnlyDirty(paths: readonly string[]): boolean {
	if (paths.length === 0) return false;
	return paths.every((p) => IGNORABLE_DIRTY_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

/** Verdict for a zero-commit push (warren-89b0), owned by the reap domain. */
export interface EmptyPushClassification {
	/** Real uncommitted work was lost — flip an otherwise-succeeded run to failed. */
	readonly droppedCommit: boolean;
	/** Deliberate no-op (clean or bookkeeping-only tree) — stays succeeded, non-alarming. */
	readonly noChanges: boolean;
	/** Human-readable `reap.empty_push` message for the resolved shape. */
	readonly message: string;
}

/**
 * Classify a zero-commit push (warren-89b0). A clean tree, or a dirty tree whose
 * ONLY paths are {@link BOOKKEEPING_ARTIFACT_PREFIXES}, is a deliberate no-op
 * (succeeded); any non-bookkeeping dirty path over a succeeded run is a dropped
 * commit (failed). Conservative: an unenumerable dirty tree (`dirtyPaths` empty
 * but `dirty` true) keeps the dropped-commit guard armed.
 */
export function classifyEmptyPush(
	succeeded: boolean,
	dirty: boolean,
	dirtyPaths: readonly string[],
): EmptyPushClassification {
	const bookkeepingOnly = dirty && isBookkeepingOnlyDirty(dirtyPaths);
	if (!dirty) {
		return {
			droppedCommit: false,
			noChanges: succeeded,
			message: "git push exited zero but the branch landed no new commits — agent did not commit",
		};
	}
	if (bookkeepingOnly) {
		return {
			droppedCommit: false,
			noChanges: succeeded,
			message:
				"git push exited zero with no new commits — agent intentionally made no code changes (only warren-managed bookkeeping or harness-owned scratch paths dirty)",
		};
	}
	return {
		droppedCommit: succeeded,
		noChanges: false,
		message:
			"git push exited zero and the workspace still has uncommitted changes — agent staged work but never committed",
	};
}

export const defaultExec: ReapExec = {
	run: async (cmd, args, opts) => {
		const execOpts: {
			cwd: string;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		} = { cwd: opts.cwd };
		if (opts.timeoutMs !== undefined) execOpts.timeout = opts.timeoutMs;
		// warren-035c/fa84: merge the caller's env OVER the inherited process env
		// (a pinned GIT_AUTHOR_*/GIT_COMMITTER_* identity beats an inherited one);
		// an `undefined` override unsets an inherited var. See resolveSpawnEnv.
		if (opts.env !== undefined) execOpts.env = resolveSpawnEnv(opts.env);
		const { stdout, stderr } = await execFileAsync(cmd, [...args], execOpts);
		return { stdout, stderr };
	},
};

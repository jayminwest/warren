/**
 * PR-context gathering for the reap pipeline's `pr_open` sub-step
 * (warren-9ee3; extracted from `pr-open.ts` in warren-45e6 to keep both
 * files under the per-file size budget).
 *
 * Best-effort collection of the data `buildPrContent` needs to fill in the
 * commits / files-changed / seeds sections: the `base..head` commit list and
 * diff stat off the host worktree (LocalProvider) or off the pushed run
 * branch fetched into the project clone (K8s, warren-ab66), plus the seed
 * attribution (warren-50c8). Every sub-call degrades to empty data rather
 * than failing the PR open.
 */

import type { IssueTracker, TrackerContext } from "../../tracker/contract.ts";
import { authenticatedCloneUrl } from "../../workspace/git/clone-url.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import type { PrCommit, PrSeed } from "../pr.ts";
import type { ReapExec } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* PR context gathering (warren-9ee3)                                       */
/* ----------------------------------------------------------------------- */

/**
 * Under K8s the pod pushes its run branch to origin and no host worktree
 * survives (`workspacePath === null`). To rebuild the commit/diff-stat sections
 * we fetch that pushed branch into the host-side project clone and diff it
 * against the base there (warren-ab66). Omit `cloneFetch` (LocalProvider, or
 * when we have no token) to keep the pre-warren-ab66 empty-section behavior.
 */
export interface CloneFetchConfig {
	/** The pushed run branch name on origin (e.g. `warren/run-1`). */
	readonly runBranch: string;
	/** Run id — namespaces the temp fetch ref so concurrent reaps never collide. */
	readonly runId: string;
	/** Project origin URL; the credential is injected into it for the fetch. */
	readonly gitUrl: string;
	/**
	 * Per-fetch git credential secret, minted from the forge immediately before
	 * the fetch (`mintGitCredential`, warren-45e6: credentials are
	 * minted, never held; forge-contract.md §4). Injected as the clone URL's
	 * userinfo by `authenticatedCloneUrl`.
	 */
	readonly gitCredential: GitSpawnCredential;
}

export interface GatherPrContextInput {
	/**
	 * Host workspace path for the commits / diff-stat git reads. `null` under K8s
	 * (the pod workspace is host-unreachable, warren-e9e1). When null and
	 * `cloneFetch` is supplied, the sections are rebuilt from the pushed run
	 * branch fetched into the project clone (warren-ab66); when null and no
	 * `cloneFetch`, they degrade to empty. The seed section always resolves off
	 * the project clone (`projectPath`).
	 */
	readonly workspacePath: string | null;
	readonly projectPath: string;
	readonly baseBranch: string;
	readonly prompt: string;
	/**
	 * Authoritative seed attribution from the run row (warren-50c8). When set it
	 * wins outright; the prompt scan below is only a legacy fallback for runs
	 * dispatched without a `seedId`.
	 */
	readonly seedId?: string | null;
	readonly exec: ReapExec;
	/** Project id for the tracker context (seeds needs only `localPath`). */
	readonly projectId?: string;
	/**
	 * The boot-resolved issue tracker (warren-47b0). The seed read goes
	 * through `getIssue` — never a hardcoded `sd` spawn. Absent (tests,
	 * unconfigured warren) → the seed section degrades to null.
	 */
	readonly issueTracker?: IssueTracker;
	/** K8s fallback source for the commit/diff-stat sections (warren-ab66). */
	readonly cloneFetch?: CloneFetchConfig;
	/**
	 * Best-effort structured-warning seam (warren-ab66). Fires
	 * `reap.pr_open_context_degraded` when the K8s clone fetch fails and the PR
	 * body falls back to empty sections. Omit in unit tests that don't assert it.
	 */
	readonly emit?: (kind: string, payload: unknown) => Promise<unknown>;
}

export interface PrContext {
	readonly commits: readonly PrCommit[];
	readonly diffStat: string;
	readonly seed: PrSeed | null;
	/**
	 * Body (not subject) of the range's final commit — the agent's handoff
	 * notes lifted into the PR body's `## Agent notes` section (warren-5e86).
	 * `null` when unreadable or empty.
	 */
	readonly finalCommitBody: string | null;
}

interface CommitStats {
	readonly commits: readonly PrCommit[];
	readonly diffStat: string;
	readonly finalCommitBody: string | null;
}

const EMPTY_STATS: CommitStats = { commits: [], diffStat: "", finalCommitBody: null };

/** Temp-ref namespace for the K8s pr-open fetch; deleted after the reads. */
const CLONE_FETCH_REF_PREFIX = "refs/warren/pr-open/";

/**
 * Best-effort gathering of the data buildPrContent needs to fill in the
 * commits / files-changed / seeds sections. Each sub-call is wrapped: a
 * git error or missing `sd` CLI degrades to empty data rather than
 * failing the PR open.
 */
export async function gatherPrContext(input: GatherPrContextInput): Promise<PrContext> {
	const [stats, seed] = await Promise.all([
		gatherCommitStats(input),
		resolveSeed({ seedId: input.seedId ?? null, prompt: input.prompt }, input.issueTracker, {
			// Seeds resolves .seeds/ off cwd; only localPath matters to it, but
			// keep the context complete when the caller knows the project id.
			projectId: input.projectId ?? "",
			localPath: input.projectPath,
		}),
	]);
	return {
		commits: stats.commits,
		diffStat: stats.diffStat,
		seed,
		finalCommitBody: stats.finalCommitBody,
	};
}

async function gatherCommitStats(input: GatherPrContextInput): Promise<CommitStats> {
	// LocalProvider: read straight off the host worktree (base..HEAD).
	if (input.workspacePath !== null) {
		return collectRange({
			exec: input.exec,
			cwd: input.workspacePath,
			baseRef: input.baseBranch,
			headRef: "HEAD",
		});
	}
	// warren-ab66: no host workspace under K8s — fetch the pushed branch into the
	// project clone and rebuild from `base..<temp ref>`. Skip when we can't fetch.
	if (input.cloneFetch === undefined) return EMPTY_STATS;
	return collectFromClone(input, input.cloneFetch);
}

/**
 * Fetch the pushed run branch into the project clone under a private temp ref,
 * rebuild the commit/diff-stat sections against the local base, then delete the
 * ref (warren-ab66). Any failure degrades to empty sections + a warning event
 * so the PR still opens — never throws.
 */
async function collectFromClone(
	input: GatherPrContextInput,
	cfg: CloneFetchConfig,
): Promise<CommitStats> {
	const tempRef = `${CLONE_FETCH_REF_PREFIX}${cfg.runId}`;
	const url = authenticatedCloneUrl(cfg.gitUrl, cfg.gitCredential);
	try {
		// Fetch only the run branch into a namespaced temp ref (never a local
		// branch); `--force` lets a re-reap overwrite a stale ref.
		await input.exec.run(
			"git",
			["fetch", "--no-tags", "--force", url, `${cfg.runBranch}:${tempRef}`],
			{ cwd: input.projectPath, timeoutMs: 30_000 },
		);
	} catch (err) {
		await input.emit?.("reap.pr_open_context_degraded", {
			runId: cfg.runId,
			branch: cfg.runBranch,
			reason: "clone_fetch_failed",
			error: err instanceof Error ? err.message : String(err),
		});
		return EMPTY_STATS;
	}
	try {
		return await collectRange({
			exec: input.exec,
			cwd: input.projectPath,
			baseRef: input.baseBranch,
			headRef: tempRef,
		});
	} finally {
		try {
			await input.exec.run("git", ["update-ref", "-d", tempRef], {
				cwd: input.projectPath,
				timeoutMs: 10_000,
			});
		} catch {
			// Best-effort cleanup — a leaked temp ref is harmless (overwritten by
			// `--force` on the next reap of the same run id).
		}
	}
}

/** A `base..head` range read against one git cwd — shared by the local and K8s paths. */
interface GitRange {
	readonly exec: ReapExec;
	readonly cwd: string;
	readonly baseRef: string;
	readonly headRef: string;
}

async function collectRange(range: GitRange): Promise<CommitStats> {
	const [commits, diffStat, finalCommitBody] = await Promise.all([
		collectCommits(range),
		collectDiffStat(range),
		collectFinalCommitBody(range),
	]);
	return { commits, diffStat, finalCommitBody };
}

/**
 * `git log -1 --format=%b <head>` — the body of the newest commit in the
 * range, the agent's final handoff notes (warren-5e86). `%b` reads the body
 * only, never the subject. Best-effort: a git error or an empty body
 * resolves to null (the PR body then omits the section).
 */
async function collectFinalCommitBody(range: GitRange): Promise<string | null> {
	try {
		const out = await range.exec.run("git", ["log", "-1", "--format=%b", range.headRef], {
			cwd: range.cwd,
			timeoutMs: 10_000,
		});
		const body = out.stdout.trim();
		return body === "" ? null : body;
	} catch {
		return null;
	}
}

async function collectCommits(range: GitRange): Promise<PrCommit[]> {
	try {
		const out = await range.exec.run(
			"git",
			["log", "--reverse", "--pretty=format:%H %s", `${range.baseRef}..${range.headRef}`],
			{ cwd: range.cwd, timeoutMs: 10_000 },
		);
		const commits: PrCommit[] = [];
		for (const raw of out.stdout.split("\n")) {
			const line = raw.trimEnd();
			if (line === "") continue;
			const sp = line.indexOf(" ");
			if (sp === -1) continue;
			commits.push({ sha: line.slice(0, sp), subject: line.slice(sp + 1) });
		}
		return commits;
	} catch {
		return [];
	}
}

async function collectDiffStat(range: GitRange): Promise<string> {
	try {
		const out = await range.exec.run(
			"git",
			["diff", "--stat", `${range.baseRef}..${range.headRef}`],
			{ cwd: range.cwd, timeoutMs: 10_000 },
		);
		return out.stdout;
	} catch {
		return "";
	}
}

// Matches seed ids like `warren-17a4`, `seeds-9ee3`, `mulch-cafe` — a
// lowercase prefix with optional internal dashes, followed by `-` and a
// 4+ char lowercase-hex suffix. Trailing hex suffix anchors the match;
// the prefix-with-dashes regex would otherwise eat ordinary words.
const SEED_ID_RE = /\b([a-z][a-z-]*-[a-f0-9]{4,})\b/g;

/**
 * Legacy fallback attribution (warren-50c8). The first regex hit used to win,
 * so a prompt merely MENTIONING another seed id mis-attributed the PR. Now the
 * scan only commits when the prompt names exactly one distinct seed id;
 * anything ambiguous degrades to no seed section rather than a wrong one.
 */
function scanPromptForSeedId(prompt: string): string | null {
	const ids = new Set<string>();
	for (const m of prompt.matchAll(SEED_ID_RE)) {
		const id = m[1];
		if (id !== undefined) ids.add(id);
	}
	if (ids.size !== 1) return null;
	return [...ids][0] ?? null;
}

interface SeedAttribution {
	readonly seedId: string | null;
	readonly prompt: string;
}

async function resolveSeed(
	attribution: SeedAttribution,
	tracker: IssueTracker | undefined,
	ctx: TrackerContext,
): Promise<PrSeed | null> {
	// warren-50c8: the run row's column is authoritative when present.
	const id = attribution.seedId ?? scanPromptForSeedId(attribution.prompt);
	if (id === null) return null;
	if (tracker === undefined) return null;
	try {
		const issue = await tracker.getIssue(ctx, id);
		if (issue.title === undefined || issue.title === "") return null;
		return { id, title: issue.title };
	} catch {
		return null;
	}
}

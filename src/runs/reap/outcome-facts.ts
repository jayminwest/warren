/**
 * Reap-time outcome facts (warren-ab2b / pl-103e step 5): persist what the
 * reap pipeline MEASURED at finalize onto the run row — `commits_ahead`
 * (finalize's own count) plus the parsed `git diff --numstat` totals
 * (`files_changed` / `insertions` / `deletions`), plus `base_sha` — the
 * resolved workspace base SHA (warren-b19e), the merge-base of the diff
 * base and the workspace HEAD, read in the same pass.
 *
 * Facts are recorded, not interpreted: no derived judgments, and NULL means
 * unknown — a skipped/failed finalize, a missing base branch, or a diff
 * that could not be measured — never zero. Historical rows predate the
 * columns and stay NULL.
 *
 * The diff is read off the host worktree under LocalProvider (`base..HEAD`,
 * the workspace is still live — terminate runs after the pipeline) or off
 * the pushed run branch fetched into the project clone under K8s (the same
 * warren-ab66 trick `pr-context.ts` uses for PR bodies). Best-effort
 * throughout: any git or fetch failure degrades that measurement to NULL.
 */

import type { Forge } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import { authenticatedCloneUrl } from "../../workspace/git/clone-url.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";
import type { ReapExec } from "./types.ts";

/** The three parsed `git diff --numstat` totals. */
export interface DiffStats {
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
}

export interface RecordOutcomeFactsInput {
	readonly runId: string;
	/** Host workspace path (LocalProvider) or `null` under K8s. */
	readonly workspacePath: string | null;
	/** The run's pushed branch (K8s clone-fetch source); null = none. */
	readonly branch: string | null;
	/**
	 * The base ref for the `base..head` diff — finalize's reported
	 * `commitsAheadBase` (the ref it counted `commits_ahead` against; a SHA on
	 * a ref-dispatch repair run, warren-ba08) else the run's base branch;
	 * null = unmeasurable (matches finalize).
	 */
	readonly baseBranch: string | null;
	readonly project: { readonly gitUrl: string; readonly localPath: string };
	/** finalize's measured count; the fact persisted verbatim. */
	readonly commitsAhead: number | null;
	/** Whether finalize pushed the branch (gates the K8s clone fetch). */
	readonly branchPushed: boolean;
	readonly exec: ReapExec;
	/** Boot-resolved forge; mints the K8s clone-fetch credential. */
	readonly forge?: Forge;
	readonly log: BoundBridgeLogger;
	/** The RunsRepo write seam (delegated so tests can stub it). */
	readonly setOutcomeFacts: (
		id: string,
		facts: {
			commitsAhead: number | null;
			baseSha: string | null;
			filesChanged: number | null;
			insertions: number | null;
			deletions: number | null;
		},
	) => Promise<unknown>;
}

/** The diff totals plus the resolved base SHA, read in one pass. */
interface OutcomeMeasurement {
	readonly stats: DiffStats | null;
	/** Resolved workspace base SHA (warren-b19e); null = unmeasurable. */
	readonly baseSha: string | null;
}

/** Temp-ref namespace for the K8s clone fetch; deleted after the read. */
const FETCH_REF_PREFIX = "refs/warren/outcome-facts/";

/**
 * Measure the diff totals and the resolved base SHA, then persist all five
 * facts. Returns the measured stats (null when unmeasurable) so the pipeline
 * can carry them on its state accumulator. The row write itself is best-effort
 * bookkeeping: a failure is logged, never thrown out of reap.
 */
export async function recordOutcomeFacts(
	input: RecordOutcomeFactsInput,
): Promise<DiffStats | null> {
	const { stats, baseSha } = await measureOutcome(input);
	try {
		await input.setOutcomeFacts(input.runId, {
			commitsAhead: input.commitsAhead,
			baseSha,
			filesChanged: stats?.filesChanged ?? null,
			insertions: stats?.insertions ?? null,
			deletions: stats?.deletions ?? null,
		});
	} catch (err) {
		input.log.warn(
			{
				event: "reap.outcome_facts_write_failed",
				runId: input.runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"outcome facts measured but the run row could not be stamped",
		);
	}
	return stats;
}

/**
 * Resolve the diff totals and the resolved workspace base SHA
 * (warren-b19e) for the run's `base..head` range. `commitsAhead === 0`
 * means the range is empty by finalize's own measurement, so the totals
 * are known zeros without a git read; `commitsAhead === null` means
 * finalize never measured, so the diff is unknown too. The base SHA is
 * measured only where a git read actually happens (alongside the diff),
 * as the merge-base of the diff base and the workspace HEAD — the commit
 * the workspace was actually cut at, pin or not.
 */
async function measureOutcome(input: RecordOutcomeFactsInput): Promise<OutcomeMeasurement> {
	if (input.commitsAhead === null) return { stats: null, baseSha: null };
	if (input.commitsAhead === 0) {
		return { stats: { filesChanged: 0, insertions: 0, deletions: 0 }, baseSha: null };
	}
	if (input.baseBranch === null) return { stats: null, baseSha: null };
	// LocalProvider: read straight off the still-live host worktree.
	if (input.workspacePath !== null) {
		const [stats, baseSha] = await Promise.all([
			numstat(input.exec, input.workspacePath, input.baseBranch, "HEAD"),
			mergeBase(input.exec, input.workspacePath, input.baseBranch, "HEAD"),
		]);
		return { stats, baseSha };
	}
	// K8s: no host worktree — fetch the pushed branch into the project clone
	// and read the range there (warren-ab66 posture). Requires the push to
	// have landed and a forge credential for the fetch.
	if (!input.branchPushed || input.branch === null || input.forge === undefined) {
		return { stats: null, baseSha: null };
	}
	const gitCredential = await mintGitCredential(input.forge, input.project.gitUrl).catch(() => {
		return undefined;
	});
	if (gitCredential === undefined) return { stats: null, baseSha: null };
	return numstatFromClone(input, gitCredential);
}

/** Fetch `branch` into the clone under a private temp ref, read numstat, delete the ref. */
async function numstatFromClone(
	input: RecordOutcomeFactsInput,
	gitCredential: GitSpawnCredential,
): Promise<OutcomeMeasurement> {
	const { branch, baseBranch, runId, exec, project } = input;
	if (branch === null || baseBranch === null) return { stats: null, baseSha: null };
	const tempRef = `${FETCH_REF_PREFIX}${runId}`;
	const url = authenticatedCloneUrl(project.gitUrl, gitCredential);
	try {
		await exec.run("git", ["fetch", "--no-tags", "--force", url, `${branch}:${tempRef}`], {
			cwd: project.localPath,
			timeoutMs: 30_000,
		});
	} catch {
		return { stats: null, baseSha: null };
	}
	try {
		const [stats, baseSha] = await Promise.all([
			numstat(exec, project.localPath, baseBranch, tempRef),
			mergeBase(exec, project.localPath, baseBranch, tempRef),
		]);
		return { stats, baseSha };
	} finally {
		try {
			await exec.run("git", ["update-ref", "-d", tempRef], {
				cwd: project.localPath,
				timeoutMs: 10_000,
			});
		} catch {
			// Best-effort cleanup — a leaked temp ref is harmless (`--force`
			// overwrites it on the next reap of the same run id).
		}
	}
}

/** Run `git merge-base base head` in `cwd`; null on failure (best-effort, warren-b19e). */
async function mergeBase(
	exec: ReapExec,
	cwd: string,
	baseRef: string,
	headRef: string,
): Promise<string | null> {
	try {
		const out = await exec.run("git", ["merge-base", baseRef, headRef], {
			cwd,
			timeoutMs: 10_000,
		});
		const sha = out.stdout.trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}

/** Run `git diff --numstat base..head` in `cwd` and parse the totals. */
async function numstat(
	exec: ReapExec,
	cwd: string,
	baseRef: string,
	headRef: string,
): Promise<DiffStats | null> {
	try {
		const out = await exec.run("git", ["diff", "--numstat", `${baseRef}..${headRef}`], {
			cwd,
			timeoutMs: 10_000,
		});
		return parseNumstat(out.stdout);
	} catch {
		return null;
	}
}

/**
 * Parse `git diff --numstat` output: one `<added>\t<deleted>\t<path>` row
 * per file, with `-` for binary files (counted as a changed file with zero
 * line deltas, matching `git diff --stat`'s "Bin 0 -> N bytes" row).
 */
export function parseNumstat(stdout: string): DiffStats {
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;
	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd();
		if (line === "") continue;
		const [added, removed] = line.split("\t");
		if (added === undefined || removed === undefined) continue;
		filesChanged++;
		if (added !== "-") insertions += Number.parseInt(added, 10) || 0;
		if (removed !== "-") deletions += Number.parseInt(removed, 10) || 0;
	}
	return { filesChanged, insertions, deletions };
}

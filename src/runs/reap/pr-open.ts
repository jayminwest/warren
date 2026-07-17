import { CI_FIXER_TRIGGER } from "../../ci-fixer/poller.ts";
import { parseGitHubUrl } from "../../projects/url.ts";
import { authenticatedCloneUrl } from "../../workspace/git/clone-url.ts";
import {
	type AutoOpenPrConfig,
	type BuildPrContentInput,
	buildPrContent,
	type OpenPullRequestInput,
	type OpenPullRequestResult,
	type PrCommit,
	type PrSeed,
} from "../pr.ts";
import type { PrTemplateOverrides } from "../pr-template.ts";
import type { ReapExec } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Retry policy for PR open (warren-70c6)                                   */
/* ----------------------------------------------------------------------- */

// 3 retries after the initial attempt: ~1s, ~2s, ~4s backoff.
const PR_OPEN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function defaultSleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true when the PR-open result warrants a retry.
 *
 * Retryable: any `http_error` that is not a known-permanent 422 shape.
 *   - "already exists" 422 is handled inside openPullRequest (returns ok:true),
 *     so it never reaches here.
 *   - "No commits between" 422 is permanent; don't retry.
 *   - All other http_errors (transient 422 e.g. "head invalid", 5xx) → retry.
 *
 * Not retried: missing_token (operator config), network (surface immediately).
 */
function isRetryablePrResult(result: OpenPullRequestResult): boolean {
	if (result.ok || result.reason !== "http_error") return false;
	if (/no commits between/i.test(result.message)) return false;
	return true;
}

/* ----------------------------------------------------------------------- */
/* PR open (warren-f6af)                                                    */
/* ----------------------------------------------------------------------- */

export interface TryOpenPrInput {
	readonly project: { gitUrl: string; defaultBranch: string };
	readonly branch: string;
	readonly autoOpen: AutoOpenPrConfig;
	readonly run: {
		id: string;
		agentName: string;
		prompt: string;
		startedAt: string | null;
		endedAt: string | null;
		costUsd: number | null;
		tokensInput: number | null;
		tokensOutput: number | null;
		tokensCacheRead: number | null;
	};
	readonly prContext: PrContext;
	readonly previewOptedIn: boolean;
	readonly openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
	readonly prTemplate?: PrTemplateOverrides;
}

export async function tryOpenPr(input: TryOpenPrInput): Promise<OpenPullRequestResult> {
	if (input.autoOpen.token === "") {
		return {
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; skipping auto-open PR",
		};
	}
	const parsed = parseGitHubUrl(input.project.gitUrl);
	const contentInput: BuildPrContentInput = {
		prompt: input.run.prompt,
		runId: input.run.id,
		agentName: input.run.agentName,
		commits: input.prContext.commits,
		diffStat: input.prContext.diffStat,
		previewOptedIn: input.previewOptedIn,
		...(input.autoOpen.warrenBaseUrl !== null
			? { warrenBaseUrl: input.autoOpen.warrenBaseUrl }
			: {}),
		...(input.prContext.seed !== null ? { seed: input.prContext.seed } : {}),
		...(input.run.startedAt !== null ? { startedAt: input.run.startedAt } : {}),
		...(input.run.endedAt !== null ? { endedAt: input.run.endedAt } : {}),
		...(input.run.costUsd !== null ? { costUsd: input.run.costUsd } : {}),
		...(input.run.tokensInput !== null ? { tokensInput: input.run.tokensInput } : {}),
		...(input.run.tokensOutput !== null ? { tokensOutput: input.run.tokensOutput } : {}),
		...(input.run.tokensCacheRead !== null ? { tokensCacheRead: input.run.tokensCacheRead } : {}),
		...(input.prTemplate !== undefined ? { templateOverrides: input.prTemplate } : {}),
	};
	const content = buildPrContent(contentInput);
	return input.openPr({
		owner: parsed.owner,
		repo: parsed.name,
		head: input.branch,
		base: input.project.defaultBranch,
		title: content.title,
		body: content.body,
		token: input.autoOpen.token,
	});
}

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
	/** Project origin URL; the token is injected into it for the fetch. */
	readonly gitUrl: string;
	/** GitHub token (same one the PR open uses); injected as `x-access-token`. */
	readonly token: string;
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
	readonly exec: ReapExec;
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
}

interface CommitStats {
	readonly commits: readonly PrCommit[];
	readonly diffStat: string;
}

const EMPTY_STATS: CommitStats = { commits: [], diffStat: "" };

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
		resolveSeed(input.prompt, input.projectPath, input.exec),
	]);
	return { commits: stats.commits, diffStat: stats.diffStat, seed };
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
	const url = authenticatedCloneUrl(cfg.gitUrl, cfg.token);
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
	const [commits, diffStat] = await Promise.all([collectCommits(range), collectDiffStat(range)]);
	return { commits, diffStat };
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
const SEED_ID_RE = /\b([a-z][a-z-]*-[a-f0-9]{4,})\b/;

async function resolveSeed(prompt: string, cwd: string, exec: ReapExec): Promise<PrSeed | null> {
	const m = SEED_ID_RE.exec(prompt);
	if (m === null) return null;
	const id = m[1];
	if (id === undefined) return null;
	try {
		const out = await exec.run("sd", ["show", id, "--format", "json"], {
			cwd,
			timeoutMs: 10_000,
		});
		const parsed: unknown = JSON.parse(out.stdout);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		const issue = obj.issue ?? obj;
		if (issue === null || typeof issue !== "object" || Array.isArray(issue)) return null;
		const title = (issue as Record<string, unknown>).title;
		if (typeof title !== "string" || title === "") return null;
		return { id, title };
	} catch {
		return null;
	}
}

export interface RunPrOpenInput {
	readonly autoOpen: AutoOpenPrConfig;
	readonly project: {
		gitUrl: string;
		defaultBranch: string;
		localPath: string;
	};
	readonly run: TryOpenPrInput["run"] & { prompt: string; trigger?: string };
	readonly branch: string;
	readonly baseBranch: string | null;
	/** Host workspace path, or `null` under K8s (PR-context git reads degrade). */
	readonly workspacePath: string | null;
	readonly previewOptedIn: boolean;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly fail: (step: "pr_open", err: unknown) => Promise<void>;
	readonly setPrUrl: (runId: string, url: string) => Promise<unknown>;
	readonly openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
	readonly prTemplate?: PrTemplateOverrides;
	/** Injected sleep for tests; defaults to real setTimeout-based sleep. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Best-effort PR-open sub-step. Returns the opened PR url on success
 * (and persists it via `setPrUrl`); `null` on skip / failure. Mirrors
 * the original inline block in `reapRun` — failures emit
 * `reap_failed` step=pr_open and never fail the run.
 */
export async function runPrOpen(input: RunPrOpenInput): Promise<string | null> {
	// warren-a993: a CI-fixer run pushed its fix onto the open PR's head branch
	// (targetBranch), which re-runs that PR's CI. A fresh PR would duplicate the
	// existing one, so self-skip here and record the reason for traceability.
	if (input.run.trigger === CI_FIXER_TRIGGER) {
		await input.emit("reap.pr_open_skipped", { reason: "ci_fixer_run", branch: input.branch });
		return null;
	}
	try {
		const prContext = await gatherPrContext({
			workspacePath: input.workspacePath,
			projectPath: input.project.localPath,
			baseBranch: input.project.defaultBranch,
			prompt: input.run.prompt,
			exec: input.exec,
			emit: input.emit,
			// warren-ab66: under K8s (no host workspace) rebuild the commit/diff-stat
			// sections from the pushed run branch fetched into the project clone. Needs
			// a token to auth the fetch; a token-less env keeps the empty-section path.
			...(input.workspacePath === null && input.autoOpen.token !== ""
				? {
						cloneFetch: {
							runBranch: input.branch,
							runId: input.run.id,
							gitUrl: input.project.gitUrl,
							token: input.autoOpen.token,
						},
					}
				: {}),
		});
		const prArgs: TryOpenPrInput = {
			project: input.project,
			branch: input.branch,
			autoOpen: input.autoOpen,
			run: input.run,
			prContext,
			previewOptedIn: input.previewOptedIn,
			openPr: input.openPr,
			...(input.prTemplate !== undefined ? { prTemplate: input.prTemplate } : {}),
		};
		const sleep = input.sleep ?? defaultSleep;
		let opened = await tryOpenPr(prArgs);
		for (let attempt = 0; attempt < PR_OPEN_RETRY_DELAYS_MS.length; attempt++) {
			if (opened.ok || !isRetryablePrResult(opened)) break;
			await sleep(PR_OPEN_RETRY_DELAYS_MS[attempt] ?? 1_000);
			opened = await tryOpenPr(prArgs);
		}
		if (opened.ok) {
			await input.setPrUrl(input.run.id, opened.url);
			await input.emit("reap.pr_opened", {
				prUrl: opened.url,
				mode: opened.mode,
				branch: input.branch,
				baseBranch: input.baseBranch,
			});
			return opened.url;
		}
		await input.fail("pr_open", new Error(`${opened.reason}: ${opened.message}`));
		return null;
	} catch (err) {
		await input.fail("pr_open", err);
		return null;
	}
}

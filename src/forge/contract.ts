/**
 * The `Forge` contract — the seam that decouples warren's domain from its
 * forge backend (GitHub today, FakeForge for the falsification tests).
 *
 * Authoritative spec: `docs/design/forge-contract.md` (§1 the interface, §2
 * the types, §4 the credential decision, §5 the capability degradations).
 * Modeled on `src/runtime/contract.ts`: capabilities as the first member,
 * per-method doc blocks naming which behaviours are firm, provider-neutral
 * DTOs, and wire vocabulary imported — never relisted — from
 * `src/core/wire.ts`.
 *
 * The invariant the contract exists to protect (§0): the domain must never
 * leak `api.github.com`, a bearer token, the literal `x-access-token`, an
 * owner/repo pair parsed out of a GitHub URL, a PR number joined to a
 * `github.com` path, or a check-run id across the seam. Everything here is
 * warren's *need*; providers satisfy it.
 *
 * Error convention (§2.2): seam methods return `ForgeResult<T>` and NEVER
 * throw. Boot-time failures (an unknown `WARREN_FORGE` selection, a provider
 * construction error) throw `UnknownForgeError` / `WarrenError` subclasses
 * from `src/forge/errors.ts`, mirroring the runtime registry.
 */

import type { ForgeErrorKind, PullRequestLifecycle } from "../core/wire.ts";

// Alias-not-relist (§2.1): the lifecycle and error-kind vocabulary live in
// the canonical home because the UI and the SDK render them. The Exact<>
// mutual-assignability tests in `contract.test.ts` are the mechanical
// stand-in that fails to compile the moment either side drifts.
export type { ForgeErrorKind, PullRequestLifecycle } from "../core/wire.ts";

/**
 * Opaque repo handle — the domain compares and passes these, and reads
 * nothing out of them. A GitHubForge packs owner/repo/host; FakeForge packs
 * a directory path. NOTHING outside the provider destructures a `RepoRef`.
 */
export interface RepoRef {
	/** registry key: "github" | "fake" */
	readonly forge: string;
	/** provider-private, stable, safe to log */
	readonly key: string;
}

/**
 * Opaque PR handle. `key` is provider-private. `webUrl` exists ONLY so the
 * UI and PR bodies can render a link, and no code parses it.
 */
export interface PullRequestRef {
	readonly forge: string;
	readonly key: string;
	/** display + tracker cross-reference */
	readonly number: number;
	readonly webUrl: string;
}

/**
 * A credential valid for ONE git operation (§4 — the load-bearing decision:
 * credentials are minted, never held). Callers invoke `gitCredential`
 * immediately before the git process spawns and MUST NOT hold the result
 * across an await that can outlast `expiresAt`. `username` is
 * provider-chosen: GitHub Apps use "x-access-token", and no domain code ever
 * names that string.
 */
export interface GitCredential {
	readonly username: string;
	readonly secret: string;
	/** epoch ms; null = no known expiry (PAT) */
	readonly expiresAt: number | null;
}

/**
 * Provider-neutral INTENT. The domain composes title and body — including
 * the 64KB clamp, which lives in `composeBody`, never in the provider (§3) —
 * and hands over finished text.
 */
export interface PullRequestDraft {
	title: string;
	body: string;
	headBranch: string;
	baseBranch: string;
	draft?: boolean;
}

export interface PullRequestQuery {
	headBranch: string;
	baseBranch: string;
	/** default "open" */
	state?: "open" | "closed" | "all";
}

export interface PullRequestState {
	lifecycle: PullRequestLifecycle;
	/** epoch ms — required, not optional: the merge-watcher blocks on it (§7) */
	mergedAt: number | null;
	headCommit: string;
	baseBranch: string;
}

/**
 * CI rollup. `conclusion` is the domain's decision input; `runs` carries
 * enough detail for the CI-fixer prompt and nothing more.
 */
export interface CheckSummary {
	conclusion: "pending" | "passing" | "failing" | "unknown";
	runs: CheckRun[];
}

/**
 * One check run. Lives HERE, not in `src/core/wire.ts`: it never crosses
 * warren's own HTTP wire — it is a seam DTO between the domain and a forge
 * provider, and the wire-vocabulary home is reserved for values the UI and
 * the SDK render (forge-contract.md §2.1).
 */
export interface CheckRun {
	name: string;
	status: "queued" | "in_progress" | "completed";
	conclusion: string | null;
	/** feeds `fetchJobLogTail`; opaque */
	jobId: string | null;
	detailsUrl: string | null;
}

/**
 * One repository the forge credential can see — the repo picker's row
 * (warren-2601). `cloneUrl` exists for the same reason `PullRequestRef.webUrl`
 * does: display and the POST /projects paste, never parsed by domain code.
 */
export interface ForgeRepoListing {
	readonly owner: string;
	readonly name: string;
	readonly cloneUrl: string;
	readonly defaultBranch: string;
	readonly private: boolean;
}

export interface GitIdentity {
	name: string;
	email: string;
}

/**
 * ONE result shape for the whole seam (§2.2) — the convention of the exact
 * code being replaced (`OpenPullRequestResult`, `CheckPrMergedResult`,
 * `FetchCheckRunsResult` were all result unions; §6.4's three-taxonomies
 * problem is a result-shape problem). The domain switches on
 * `ForgeErrorKind`; nothing catches across the seam.
 */
export type ForgeResult<T> = { ok: true; value: T } | { ok: false; error: ForgeError };

export interface ForgeError {
	kind: ForgeErrorKind;
	/** transport status, for logs only */
	status?: number;
	/** set on rate_limited when the forge knows */
	retryAfterMs?: number;
	/** redacted, safe to persist on a run row */
	detail: string;
}

/**
 * What a forge can and can't do — the domain branches on these, it does not
 * assume (§5). Every declared flag has a stated domain fallback; a provider
 * returns the `unsupported` error kind when the domain calls past a false
 * flag. `checkRuns` is the painful one: a fine-grained PAT cannot reach the
 * Checks API at all (§6.7), which is the strongest argument for the
 * capability-flag style over a scattered `hasApp` conditional.
 */
export interface ForgeCapabilities {
	/** Checks API reachable (GitHubPat: FALSE) */
	checkRuns: boolean;
	/** log tail available */
	jobLogs: boolean;
	/** preview annotation can PATCH the PR body */
	pullRequestBodyEdit: boolean;
	/** acceptance cleanup can delete branch refs */
	branchDelete: boolean;
	/** the forge names its own bot */
	botIdentity: boolean;
	/** installation repository listing (GitHubApp: TRUE; PAT/fake: FALSE) */
	installationRepos: boolean;
	/** drives the §4 re-mint: "static" skips it, "short-lived" requires it */
	credentialLifetime: "static" | "short-lived";
}

/**
 * The forge seam. Ten methods. `parseRepoRef`, `openPullRequest`,
 * `findPullRequest`, `getPullRequest`, `setPullRequestBody`, `listChecks`,
 * `fetchJobLogTail`, and `deleteBranch` are FIRM — each replaces a call site
 * that exists today and the audit grounds every signature. `gitCredential`
 * is the method whose *shape* carries the §4 decision. `botIdentity` is the
 * least certain: warren sets the author identity from env today, and a
 * forge-supplied identity only earns its place once App mode ships.
 *
 * There is deliberately no `mergePullRequest`: warren merges through
 * GitHub's auto-merge workflow, not through the API, and a merge method
 * would give the seam a capability with no caller.
 */
export interface Forge {
	readonly capabilities: ForgeCapabilities;

	/**
	 * Parse a clone URL into an opaque, forge-neutral ref. NEVER throws — a
	 * URL this forge does not own returns `null`, and the registry tries the
	 * next forge in its fixed boot order (§1.1).
	 */
	parseRepoRef(cloneUrl: string): RepoRef | null;

	/**
	 * Mint a git-over-HTTPS credential for one operation (§4). GitHubApp:
	 * POST /app/installations/:id/access_tokens; GitHubPat: the static secret
	 * with `expiresAt: null`.
	 */
	gitCredential(ref: RepoRef): Promise<ForgeResult<GitCredential>>;

	/**
	 * Open a pull request. Idempotent by contract: a forge that reports a
	 * duplicate MUST resolve it to the existing PR rather than surface a
	 * conflict. GitHub's 422-then-search dance stays inside the provider.
	 */
	openPullRequest(ref: RepoRef, req: PullRequestDraft): Promise<ForgeResult<PullRequestRef>>;

	/**
	 * Find an open PR for a head/base pair. Returns ok with a `null` value
	 * when none exists — a missing PR is not an error.
	 */
	findPullRequest(ref: RepoRef, q: PullRequestQuery): Promise<ForgeResult<PullRequestRef | null>>;

	/**
	 * Read PR lifecycle state. The plan-run merge gate and the merge-watcher
	 * are the two consumers.
	 */
	getPullRequest(ref: RepoRef, pr: PullRequestRef): Promise<ForgeResult<PullRequestState>>;

	/**
	 * Rewrite a PR body. The domain composes the body; the forge only
	 * transports it (§3).
	 */
	setPullRequestBody(ref: RepoRef, pr: PullRequestRef, body: string): Promise<ForgeResult<void>>;

	/**
	 * Read CI state for a commit. Gated by `capabilities.checkRuns` — a
	 * fine-grained PAT cannot reach this API at all (§5, §6.7).
	 */
	listChecks(ref: RepoRef, commit: string): Promise<ForgeResult<CheckSummary>>;

	/**
	 * Tail a failing job's log. Best-effort by contract: a forge that cannot
	 * supply logs returns ok with `null`, not an error.
	 */
	fetchJobLogTail(
		ref: RepoRef,
		jobId: string,
		maxBytes: number,
	): Promise<ForgeResult<string | null>>;

	/**
	 * Delete a branch ref. Used by the acceptance harness only; present on
	 * the contract so FakeForge can satisfy the same cleanup path.
	 */
	deleteBranch(ref: RepoRef, branch: string): Promise<ForgeResult<void>>;

	/**
	 * The identity authored commits should carry. Authorization and
	 * authorship are separate concerns on every forge (§6.8).
	 */
	botIdentity(): Promise<ForgeResult<GitIdentity>>;

	/**
	 * List the repositories the credential can see (warren-2601 — the Add
	 * Project repo picker). Gated by `capabilities.installationRepos`: an
	 * installation-scoped credential (GitHub App) lists its installation's
	 * repositories; a PAT has no installation scope and returns `unsupported`.
	 */
	listInstallationRepos(): Promise<ForgeResult<readonly ForgeRepoListing[]>>;
}

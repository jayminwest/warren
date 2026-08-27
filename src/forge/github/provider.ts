/**
 * GitHubForge — implementation #1 of the `Forge` contract (plan pl-d1c9
 * step 8, forge-contract.md §1), the PAT/static-credential mode over the
 * phase-1 transport core (`./http.ts`).
 *
 * What this provider is:
 *   - `parseRepoRef` absorbs the five audited URL grammars (§6.3): https and
 *     ssh clone URLs, scp-style `git@github.com:`, PR web URLs (query and
 *     fragment tolerated), and REST API URLs. It NEVER throws and returns
 *     `null` for foreign hosts. The `[A-Za-z0-9._-]+` per-segment validation
 *     from `src/projects/url.ts` survives into the packed key verbatim —
 *     that rule guards `/data/projects` path safety (mx-e741b0), so a `.`,
 *     `..`, or leading-dash segment rejects the URL outright.
 *   - `openPullRequest` is idempotent by contract: GitHub's 422-then-search
 *     dance stays inside. The duplicate search preserves the two-pass form
 *     landed in phase-1 PR #824 (`src/runs/pr.ts` `findExistingPr`) — a
 *     direct `head=<owner>:<branch>` filter, then an on-base scan matching
 *     `head.ref` — so a duplicate whose head lives on a fork is found
 *     rather than degrading to an opaque conflict (§6.13).
 *   - `gitCredential` returns the minted credential — under the default
 *     static source that is the configured PAT with `expiresAt: null` (§4 —
 *     static lifetime skips the re-mint path); the App provider injects its
 *     installation-token cache as the `tokenSource` and rides every method
 *     below unchanged.
 *
 * Capabilities (§5): `checkRuns` defaults true — a CLASSIC PAT reaches the
 * Checks API. A FINE-GRAINED PAT cannot (GitHub's fine-grained permission
 * reference has no Checks section, §6.7); an operator running one passes
 * `checkRuns: false` and the domain degrades per §5. `botIdentity` is
 * false: the token authorizes but does not name the author (§6.8), so
 * warren keeps naming commits via `WARREN_GIT_AUTHOR_*`.
 *
 * Seam discipline (§2.2): every method returns `ForgeResult<T>` and never
 * throws. Boot-time failures (the registry's unknown-kind throw) live in
 * `src/forge/registry.ts`.
 */

import type {
	CheckRun,
	CheckSummary,
	Forge,
	ForgeCapabilities,
	ForgeError,
	ForgeRepoListing,
	ForgeResult,
	GitCredential,
	GitIdentity,
	PullRequestDraft,
	PullRequestQuery,
	PullRequestRef,
	PullRequestState,
	RepoRef,
} from "../contract.ts";
import type { GitHubHttpError } from "./errors.ts";
import { GITHUB_API_BASE } from "./headers.ts";
import { requestGitHub } from "./http.ts";
import { readJson, readText } from "./readers.ts";
import { GITHUB_FORGE_KIND, parseGitHubRepoRef } from "./repo-ref.ts";
import {
	type GitHubCredentialSecret,
	type GitHubForgeTokenSource,
	StaticGitHubTokenSource,
} from "./token-source.ts";

export { GITHUB_FORGE_KIND } from "./repo-ref.ts";

const USER_AGENT = "warren-forge-github";

export interface GitHubForgeOptions {
	/**
	 * The static secret (a PAT). Empty string → methods return `no_credential`.
	 * Ignored when `tokenSource` is set.
	 */
	readonly token?: string;
	/**
	 * Dynamic per-call credential source (forge-contract.md §4) — the App
	 * provider's installation-token cache implements it. When set, every API
	 * method mints immediately before its request instead of reading `token`.
	 */
	readonly tokenSource?: GitHubForgeTokenSource;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * Override for `capabilities.checkRuns`. Default true (classic PAT). Set
	 * false for a fine-grained PAT, which cannot reach the Checks API (§6.7).
	 */
	readonly checkRuns?: boolean;
}

/** Failure-ish conclusions the CI rollup counts as `failing`. */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"action_required",
	"cancelled",
	"startup_failure",
]);

function ok<T>(value: T): ForgeResult<T> {
	return { ok: true, value };
}

function err<T>(error: ForgeError): ForgeResult<T> {
	return { ok: false, error };
}

/**
 * Transport-kind vocabulary aligns with the seam kinds — the map is a
 * rename. Exported for the App provider's installation-token mint, which
 * rides the same transport and maps its failures identically.
 */
export function toForgeError(error: GitHubHttpError): ForgeError {
	const forgeError: ForgeError = { kind: error.kind, status: error.status, detail: error.message };
	if (error.kind === "rate_limited" && error.retryAfterMs !== null) {
		return { ...forgeError, retryAfterMs: error.retryAfterMs };
	}
	return forgeError;
}

interface GitHubPrJson {
	readonly number?: unknown;
	readonly html_url?: unknown;
	readonly state?: unknown;
	readonly merged_at?: unknown;
	readonly head?: unknown;
	readonly base?: unknown;
}

function prNumber(json: GitHubPrJson): number | null {
	return typeof json.number === "number" && json.number > 0 ? json.number : null;
}

function prWebUrl(json: GitHubPrJson): string | null {
	return typeof json.html_url === "string" ? json.html_url : null;
}

export class GitHubForge implements Forge {
	readonly capabilities: ForgeCapabilities;

	private readonly tokens: GitHubForgeTokenSource;
	private readonly fetch: typeof fetch;

	constructor(options: GitHubForgeOptions) {
		this.tokens = options.tokenSource ?? new StaticGitHubTokenSource(options.token ?? "");
		this.fetch = options.fetch ?? globalThis.fetch;
		this.capabilities = {
			checkRuns: options.checkRuns ?? true,
			jobLogs: true,
			pullRequestBodyEdit: true,
			branchDelete: true,
			// The token authorizes; it does not name the author (§6.8). Warren
			// names commits via WARREN_GIT_AUTHOR_* until App mode ships.
			botIdentity: false,
			// A PAT has no installation scope (§5): no repo listing.
			installationRepos: false,
			credentialLifetime: "static",
		};
	}

	parseRepoRef(cloneUrl: string): RepoRef | null {
		return parseGitHubRepoRef(cloneUrl);
	}

	async gitCredential(ref: RepoRef): Promise<ForgeResult<GitCredential>> {
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		// The provider owns the username; no domain code ever names it.
		// `expiresAt` is null under the static source (§4: the domain skips
		// the re-mint) and real under the App source.
		return ok({
			username: "x-access-token",
			secret: minted.value.secret,
			expiresAt: minted.value.expiresAt,
		});
	}

	async openPullRequest(ref: RepoRef, req: PullRequestDraft): Promise<ForgeResult<PullRequestRef>> {
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/repos/${this.slug(ref)}/pulls`,
			method: "POST",
			token: minted.value.secret,
			userAgent: USER_AGENT,
			context: "POST /pulls",
			body: {
				title: req.title,
				body: req.body,
				head: req.headBranch,
				base: req.baseBranch,
				...(req.draft !== undefined ? { draft: req.draft } : {}),
			},
			fetch: this.fetch,
		});
		if (!result.ok) {
			// Idempotency (§1): a 422 "already exists" resolves to the existing
			// PR rather than surfacing a conflict.
			if (result.error.status === 422 && /already exists/i.test(result.error.message)) {
				const existing = await this.findPullRequest(ref, {
					headBranch: req.headBranch,
					baseBranch: req.baseBranch,
				});
				if (existing.ok && existing.value !== null) return ok(existing.value);
			}
			return err(toForgeError(result.error));
		}
		const created = (await readJson(result.response)) as GitHubPrJson | null;
		if (created === null) {
			return err({ kind: "http_error", detail: "POST /pulls returned an unreadable body" });
		}
		return this.prRefResult(ref, created);
	}

	async findPullRequest(
		ref: RepoRef,
		q: PullRequestQuery,
	): Promise<ForgeResult<PullRequestRef | null>> {
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		const state = q.state ?? "open";
		// Pass 1: the owner-qualified head filter. Only matches same-repo
		// branches — GitHub scopes `head=<owner>:<branch>` to that owner.
		const direct = await this.searchPullRequests(ref, minted.value.secret, {
			base: q.baseBranch,
			state,
			head: `${this.owner(ref)}:${q.headBranch}`,
			per_page: "1",
		});
		if (!direct.ok) return err(direct.error);
		const directHit = direct.value[0];
		if (directHit !== undefined) return ok(directHit.ref);
		// Pass 2 (§6.13): an on-base scan matching `head.ref` finds a duplicate
		// whose head lives on a fork, which pass 1 cannot see.
		const onBase = await this.searchPullRequests(ref, minted.value.secret, {
			base: q.baseBranch,
			state,
			per_page: "100",
		});
		if (!onBase.ok) return err(onBase.error);
		for (const hit of onBase.value) {
			if (hit.headBranch === q.headBranch) return ok(hit.ref);
		}
		return ok(null);
	}

	async getPullRequest(ref: RepoRef, pr: PullRequestRef): Promise<ForgeResult<PullRequestState>> {
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/repos/${this.slug(ref)}/pulls/${pr.number}`,
			method: "GET",
			token: minted.value.secret,
			userAgent: USER_AGENT,
			context: `GET /pulls/${pr.number}`,
			fetch: this.fetch,
		});
		if (!result.ok) return err(toForgeError(result.error));
		const body = (await readJson(result.response)) as GitHubPrJson | null;
		if (body === null) {
			return err({ kind: "http_error", detail: `GET /pulls/${pr.number} returned no body` });
		}
		const mergedAtRaw = typeof body.merged_at === "string" ? Date.parse(body.merged_at) : null;
		const mergedAt = mergedAtRaw !== null && Number.isFinite(mergedAtRaw) ? mergedAtRaw : null;
		const lifecycle =
			mergedAt !== null ? "merged" : body.state === "closed" ? "closed_unmerged" : "open";
		const head = body.head as { sha?: unknown } | undefined;
		const base = body.base as { ref?: unknown } | undefined;
		return ok({
			lifecycle,
			mergedAt,
			headCommit: typeof head?.sha === "string" ? head.sha : "",
			baseBranch: typeof base?.ref === "string" ? base.ref : "",
		});
	}

	async setPullRequestBody(
		ref: RepoRef,
		pr: PullRequestRef,
		body: string,
	): Promise<ForgeResult<void>> {
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/repos/${this.slug(ref)}/pulls/${pr.number}`,
			method: "PATCH",
			token: minted.value.secret,
			userAgent: USER_AGENT,
			context: `PATCH /pulls/${pr.number}`,
			body: { body },
			fetch: this.fetch,
		});
		if (!result.ok) return err(toForgeError(result.error));
		return ok(undefined);
	}

	async listChecks(ref: RepoRef, commit: string): Promise<ForgeResult<CheckSummary>> {
		if (!this.capabilities.checkRuns) {
			return err({
				kind: "unsupported",
				detail:
					"capabilities.checkRuns is false (fine-grained PAT cannot reach the Checks API — §5/§6.7)",
			});
		}
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/repos/${this.slug(ref)}/commits/${encodeURIComponent(commit)}/check-runs?per_page=100`,
			method: "GET",
			token: minted.value.secret,
			userAgent: USER_AGENT,
			context: "GET /check-runs",
			fetch: this.fetch,
		});
		if (!result.ok) return err(toForgeError(result.error));
		const body = (await readJson(result.response)) as { check_runs?: unknown } | null;
		const raw = Array.isArray(body?.check_runs) ? body.check_runs : [];
		const runs = raw.map(parseCheckRun).filter((r): r is CheckRun => r !== null);
		return ok({ conclusion: rollUp(runs), runs });
	}

	/** Best-effort by contract: any failure degrades to ok with `null`. */
	async fetchJobLogTail(
		ref: RepoRef,
		jobId: string,
		maxBytes: number,
	): Promise<ForgeResult<string | null>> {
		if (maxBytes <= 0) return ok(null);
		const minted = await this.mint(ref);
		if (!minted.ok) return ok(null);
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/repos/${this.slug(ref)}/actions/jobs/${encodeURIComponent(jobId)}/logs`,
			method: "GET",
			token: minted.value.secret,
			userAgent: USER_AGENT,
			context: `GET /actions/jobs/${jobId}/logs`,
			fetch: this.fetch,
		});
		if (!result.ok) return ok(null);
		const text = (await readText(result.response)).replace(/\s+$/, "");
		if (text === "") return ok(null);
		return ok(text.length <= maxBytes ? text : text.slice(text.length - maxBytes));
	}

	async deleteBranch(ref: RepoRef, branch: string): Promise<ForgeResult<void>> {
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/repos/${this.slug(ref)}/git/refs/heads/${encodeURIComponent(branch)}`,
			method: "DELETE",
			token: minted.value.secret,
			userAgent: USER_AGENT,
			context: `DELETE /git/refs/heads/${branch}`,
			fetch: this.fetch,
		});
		if (!result.ok) return err(toForgeError(result.error));
		return ok(undefined);
	}

	/** PAT mode holds no bot identity (§5): the domain falls back to env. */
	botIdentity(): Promise<ForgeResult<GitIdentity>> {
		return Promise.resolve(
			err({
				kind: "unsupported",
				detail:
					"GitHubForge (PAT/static mode) holds no bot identity — warren names the author via WARREN_GIT_AUTHOR_* (§6.8)",
			}),
		);
	}

	/** PAT mode has no installation scope (§5): the repo picker falls back to URL paste. */
	listInstallationRepos(): Promise<ForgeResult<readonly ForgeRepoListing[]>> {
		return Promise.resolve(
			err({
				kind: "unsupported",
				detail:
					"GitHubForge (PAT/static mode) has no installation scope — no repository listing (§5)",
			}),
		);
	}

	/* ------------------------------------------------------------------- */

	/**
	 * Mint the credential for ONE API call (§4) — a free static read under
	 * PAT mode, a cache hit or installation-token re-mint under App mode.
	 * A `no_credential` miss is re-detailed with the repo ref so the error
	 * names the operation it failed, matching the pre-source behavior.
	 */
	private async mint(ref: RepoRef): Promise<ForgeResult<GitHubCredentialSecret>> {
		const minted = await this.tokens.mint();
		if (minted.ok) return minted;
		if (minted.error.kind === "no_credential") {
			return err({
				kind: "no_credential",
				detail: `no GitHub credential configured; cannot call the forge for ${ref.key}`,
			});
		}
		return err(minted.error);
	}

	/** RepoRef keys pack `github.com/<owner>/<repo>`; only this provider destructures them. */
	private slug(ref: RepoRef): string {
		return ref.key.slice("github.com/".length);
	}

	private owner(ref: RepoRef): string {
		return this.slug(ref).split("/")[0] ?? "";
	}

	private prRefResult(ref: RepoRef, json: GitHubPrJson): ForgeResult<PullRequestRef> {
		const number = prNumber(json);
		const webUrl = prWebUrl(json);
		if (number === null || webUrl === null) {
			return err({ kind: "http_error", detail: "forge response carried no PR number/url" });
		}
		return ok(this.toRef(ref, number, webUrl));
	}

	private toRef(ref: RepoRef, number: number, webUrl: string): PullRequestRef {
		return { forge: GITHUB_FORGE_KIND, key: `${ref.key}#${number}`, number, webUrl };
	}

	/**
	 * The two-pass open-PR search behind `findPullRequest` and the 422
	 * recovery in `openPullRequest`. Returns refs paired with each PR's
	 * `head.ref` so the cross-fork pass can match on it.
	 */
	private async searchPullRequests(
		ref: RepoRef,
		token: string,
		params: Record<string, string>,
	): Promise<ForgeResult<Array<{ ref: PullRequestRef; headBranch: string }>>> {
		const query = new URLSearchParams(params);
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/repos/${this.slug(ref)}/pulls?${query.toString()}`,
			method: "GET",
			token,
			userAgent: USER_AGENT,
			context: "GET /pulls",
			fetch: this.fetch,
		});
		if (!result.ok) return err(toForgeError(result.error));
		const list = (await readJson(result.response)) as readonly GitHubPrJson[] | null;
		if (!Array.isArray(list)) {
			return err({ kind: "http_error", detail: "GET /pulls returned a non-list body" });
		}
		const hits: Array<{ ref: PullRequestRef; headBranch: string }> = [];
		for (const item of list) {
			const number = prNumber(item);
			const webUrl = prWebUrl(item);
			if (number === null || webUrl === null) continue;
			const head = item.head as { ref?: unknown } | undefined;
			hits.push({
				ref: this.toRef(ref, number, webUrl),
				headBranch: typeof head?.ref === "string" ? head.ref : "",
			});
		}
		return ok(hits);
	}
}

function parseCheckRun(raw: unknown): CheckRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.id !== "number") return null;
	const detailsUrl = typeof obj.details_url === "string" ? obj.details_url : null;
	return {
		name: typeof obj.name === "string" ? obj.name : "",
		status: obj.status === "queued" || obj.status === "completed" ? obj.status : "in_progress",
		conclusion: typeof obj.conclusion === "string" ? obj.conclusion : null,
		jobId: String(extractJobId(detailsUrl, obj.id)),
		detailsUrl,
	};
}

/**
 * GitHub Actions check-runs link to `.../actions/runs/<run>/job/<job_id>`;
 * the trailing job id is what the logs endpoint needs. Falls back to the
 * check-run id for third-party CI (same rule as `src/ci-fixer/check-runs.ts`).
 */
function extractJobId(detailsUrl: string | null, fallbackId: number): number {
	if (detailsUrl !== null) {
		const match = /\/job\/(\d+)/.exec(detailsUrl);
		if (match?.[1] !== undefined) {
			const parsed = Number.parseInt(match[1], 10);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return fallbackId;
}

/** Roll a commit's check runs up to the domain's decision input. */
function rollUp(runs: CheckRun[]): CheckSummary["conclusion"] {
	if (runs.length === 0) return "unknown";
	if (runs.some((r) => r.status !== "completed")) return "pending";
	if (runs.some((r) => r.conclusion !== null && FAILURE_CONCLUSIONS.has(r.conclusion))) {
		return "failing";
	}
	return "passing";
}

import {
	composeBody,
	composeTitle,
	type PrFragmentContext,
	type PrTemplateOverrides,
} from "./pr-template.ts";

/**
 * `openPullRequest` — open a GitHub PR for a branch reap just pushed
 * (warren-f6af). Fourth best-effort sub-step of `reapRun`, gated by
 * `WARREN_AUTO_OPEN_PR` (default on).
 *
 * The call hits the GitHub REST API directly (`POST /repos/:owner/:repo/pulls`)
 * via an injected `fetch` seam — no shell-out to `gh`, no extra runtime
 * dependency. Auth is `GITHUB_TOKEN`, the same token the supervisor wires
 * into git's `insteadOf` rule at boot (warren-dcf3).
 *
 * Failure shapes (callers translate into `reap_failed` events; reap never
 * crashes the run because the PR step blew up):
 *   - `missing_token` — `GITHUB_TOKEN` unset/empty. Skip cleanly.
 *   - `pr_exists`    — GitHub returns 422 because a PR already covers the
 *                       same head→base. Treated as success: re-fetch the
 *                       existing PR's `html_url` so the caller still gets
 *                       a link to surface (idempotency for re-runs and
 *                       restart-recovery sweeps).
 *   - `network`      — fetch threw or non-2xx response that isn't a
 *                       known idempotent shape.
 *
 * The body and title format is template-driven (warren-bd49): the body
 * comes from the named-fragment registry in `src/runs/pr-template.ts`,
 * and projects override individual fragments via
 * `.warren/pr-template.md`. Title follows the same registry: a project
 * `title` override wins; otherwise the seed/commit/prompt precedence
 * chain applies.
 */

export interface OpenPullRequestInput {
	readonly owner: string;
	readonly repo: string;
	readonly head: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
	readonly token: string;
}

export type OpenPullRequestResult =
	| { readonly ok: true; readonly url: string; readonly mode: "created" | "exists" }
	| {
			readonly ok: false;
			readonly reason: "missing_token" | "network" | "http_error";
			readonly message: string;
	  };

export interface PrFetcher {
	readonly fetch: typeof fetch;
}

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "warren-reap-pr-open";

/**
 * Acceptance test seam (warren-ae00 / scenario 26). When
 * `WARREN_GH_FETCH_OVERRIDE` is set, every GitHub REST call short-circuits
 * to a canned positive response — `openPullRequest` returns a synthetic
 * `pull/1` URL and `checkPullRequestMerged` returns `merged` immediately.
 * Lets the in-proc plan-run roundtrip exercise reap's PR open + the
 * coordinator's pr_open → merged transition without standing up a real
 * GitHub fixture. Unset in production deployments.
 */
const GH_FETCH_OVERRIDE_ENV = "WARREN_GH_FETCH_OVERRIDE";

function readGhFetchOverride(): "merged" | null {
	const v = process.env[GH_FETCH_OVERRIDE_ENV];
	if (typeof v !== "string") return null;
	return v.trim() === "merged" ? "merged" : null;
}

export async function openPullRequest(
	input: OpenPullRequestInput,
	deps: PrFetcher = { fetch: globalThis.fetch },
): Promise<OpenPullRequestResult> {
	if (readGhFetchOverride() === "merged") {
		return {
			ok: true,
			url: `https://github.com/${input.owner}/${input.repo}/pull/1`,
			mode: "created",
		};
	}
	if (input.token === "") {
		return {
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; cannot open pull request",
		};
	}

	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls`;
	const headers = buildHeaders(input.token);

	let res: Response;
	try {
		res = await deps.fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
			}),
		});
	} catch (err) {
		return {
			ok: false,
			reason: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 201) {
		const created = (await readJson(res)) as { html_url?: unknown } | null;
		const link = typeof created?.html_url === "string" ? created.html_url : null;
		if (link === null) {
			return { ok: false, reason: "http_error", message: "POST /pulls returned no html_url" };
		}
		return { ok: true, url: link, mode: "created" };
	}

	if (res.status === 422) {
		// 422 covers both "PR already exists" and "no commits between head and
		// base". The first is idempotent — fetch the existing PR and return
		// its url. The second is a no-op shape callers are expected to skip
		// upstream (commitsAhead === 0), but if it slips through we surface
		// the message so the operator sees why.
		const body = (await readJson(res)) as { errors?: unknown; message?: unknown } | null;
		const message = typeof body?.message === "string" ? body.message : "422 from POST /pulls";
		const errorsBlob = JSON.stringify(body?.errors ?? []);
		if (/already exists|pull request already exists/i.test(errorsBlob + message)) {
			const existing = await findExistingPr(input, deps);
			if (existing !== null) {
				return { ok: true, url: existing, mode: "exists" };
			}
			return {
				ok: false,
				reason: "http_error",
				message: "PR already exists but lookup did not return a url",
			};
		}
		return { ok: false, reason: "http_error", message: `${message} errors=${errorsBlob}` };
	}

	const text = await readText(res);
	return {
		ok: false,
		reason: "http_error",
		message: `POST /pulls returned ${res.status}: ${truncate(text, 500)}`,
	};
}

async function findExistingPr(
	input: OpenPullRequestInput,
	deps: PrFetcher,
): Promise<string | null> {
	const params = new URLSearchParams({
		head: `${input.owner}:${input.head}`,
		base: input.base,
		state: "open",
		per_page: "1",
	});
	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls?${params.toString()}`;
	let res: Response;
	try {
		res = await deps.fetch(url, { method: "GET", headers: buildHeaders(input.token) });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const list = (await readJson(res)) as Array<{ html_url?: unknown }> | null;
	if (!Array.isArray(list) || list.length === 0) return null;
	const first = list[0];
	return typeof first?.html_url === "string" ? first.html_url : null;
}

function buildHeaders(token: string): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};
}

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
}

/* ----------------------------------------------------------------------- */
/* Title + body formatting                                                  */
/* ----------------------------------------------------------------------- */

const TITLE_MAX_LENGTH = 72;

export interface PrCommit {
	readonly sha: string;
	readonly subject: string;
}

export interface PrSeed {
	readonly id: string;
	readonly title: string;
}

export interface BuildPrContentInput {
	readonly prompt: string;
	readonly runId: string;
	readonly agentName: string;
	/** Optional warren UI base URL (e.g. `https://warren.example.com`). */
	readonly warrenBaseUrl?: string;
	/** Commits ahead of the base branch, oldest-first. */
	readonly commits?: readonly PrCommit[];
	/** Raw `git diff --stat <base>..HEAD` output (multi-line). */
	readonly diffStat?: string;
	/** Resolved seed referenced by the prompt (best-effort `sd show`). */
	readonly seed?: PrSeed;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly costUsd?: number;
	readonly tokensInput?: number;
	readonly tokensOutput?: number;
	readonly tokensCacheRead?: number;
	/**
	 * Project opted into per-run preview environments (R-19 / SPEC §11.L).
	 * When true, the body includes a `preview_url_or_placeholder` fragment
	 * (a `## Preview` section bracketed by `<!-- warren:preview-start -->`
	 * and `<!-- warren:preview-end -->`) so reap's `pr_annotate_preview`
	 * sub-step can patch in the live URL once the sidecar is ready. False /
	 * absent renders no fragment — non-opted-in projects don't see preview
	 * scaffolding in their PR body.
	 */
	readonly previewOptedIn?: boolean;
	/**
	 * Per-project PR-template overrides (warren-bd49). Loaded from
	 * `.warren/pr-template.md` by `loadPrTemplate` and threaded through
	 * `reapRun`. Each key is a fragment name from `PR_FRAGMENT_NAMES`
	 * (`src/runs/pr-template.ts`); the value replaces the default body
	 * for that fragment. Whitespace-only values remove the fragment
	 * from the output. Omitted / undefined → defaults apply.
	 */
	readonly templateOverrides?: PrTemplateOverrides;
}

/**
 * Markers `pr_annotate_preview` looks for when patching the live URL or
 * failure tail into the PR body (warren-f156). Exported so the annotator
 * can match without duplicating the literal — drift between the two
 * sides would silently break idempotency.
 */
export const PREVIEW_FRAGMENT_START = "<!-- warren:preview-start -->" as const;
export const PREVIEW_FRAGMENT_END = "<!-- warren:preview-end -->" as const;

export interface PrContent {
	readonly title: string;
	readonly body: string;
}

/**
 * Build the PR title and body (warren-9ee3).
 *
 * Body is composed from named fragments via the registry in
 * `src/runs/pr-template.ts` (warren-bd49); project overrides from
 * `.warren/pr-template.md` thread through `input.templateOverrides`
 * and replace individual fragments by name.
 *
 * Title precedence — first non-empty wins:
 *   1. Project `title` override (when supplied via templateOverrides).
 *   2. Resolved seed title (`seed.title`) when the prompt referenced a seed.
 *   3. First commit subject on the branch.
 *   4. First non-empty line of the prompt.
 *   5. `warren run <id> (<agent>)` fallback for empty prompts.
 *
 * Body fragments (in order, omitted when their data is absent and
 * the project hasn't overridden):
 *   - summary, run, seeds, preview_url_or_placeholder, commits,
 *     files_changed, prompt, trailer
 */
export function buildPrContent(input: BuildPrContentInput): PrContent {
	const ctx: PrFragmentContext = buildContext(input);
	const overrides = input.templateOverrides ?? {};
	return {
		title: composeTitle(ctx, overrides, TITLE_MAX_LENGTH),
		body: composeBody(ctx, overrides),
	};
}

function buildContext(input: BuildPrContentInput): PrFragmentContext {
	const ctx: {
		prompt: string;
		runId: string;
		agentName: string;
		warrenBaseUrl?: string;
		commits?: readonly PrCommit[];
		diffStat?: string;
		seed?: PrSeed;
		startedAt?: string;
		endedAt?: string;
		costUsd?: number;
		tokensInput?: number;
		tokensOutput?: number;
		tokensCacheRead?: number;
		previewOptedIn?: boolean;
	} = {
		prompt: input.prompt,
		runId: input.runId,
		agentName: input.agentName,
	};
	if (input.warrenBaseUrl !== undefined) ctx.warrenBaseUrl = input.warrenBaseUrl;
	if (input.commits !== undefined) ctx.commits = input.commits;
	if (input.diffStat !== undefined) ctx.diffStat = input.diffStat;
	if (input.seed !== undefined) ctx.seed = input.seed;
	if (input.startedAt !== undefined) ctx.startedAt = input.startedAt;
	if (input.endedAt !== undefined) ctx.endedAt = input.endedAt;
	if (input.costUsd !== undefined) ctx.costUsd = input.costUsd;
	if (input.tokensInput !== undefined) ctx.tokensInput = input.tokensInput;
	if (input.tokensOutput !== undefined) ctx.tokensOutput = input.tokensOutput;
	if (input.tokensCacheRead !== undefined) ctx.tokensCacheRead = input.tokensCacheRead;
	if (input.previewOptedIn !== undefined) ctx.previewOptedIn = input.previewOptedIn;
	return ctx;
}

/* ----------------------------------------------------------------------- */
/* Config                                                                   */
/* ----------------------------------------------------------------------- */

export interface AutoOpenPrConfig {
	readonly enabled: boolean;
	readonly token: string;
	readonly warrenBaseUrl: string | null;
}

export type AutoOpenEnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the auto-open config (warren-f6af). `WARREN_AUTO_OPEN_PR` defaults
 * to enabled — the seed's whole point is "agent run → reviewable change with
 * no manual hop". Anything that isn't a recognized falsy value (`0`, `false`,
 * `no`, `off`, case-insensitive, with whitespace tolerated) leaves it on, so
 * an operator can disable globally with `WARREN_AUTO_OPEN_PR=false` without
 * tripping a stricter parser.
 */
export function loadAutoOpenPrConfigFromEnv(env: AutoOpenEnvLike = process.env): AutoOpenPrConfig {
	const raw = env.WARREN_AUTO_OPEN_PR;
	const enabled = raw === undefined ? true : !isFalsy(raw);
	const fetchOverride = env[GH_FETCH_OVERRIDE_ENV];
	const overrideActive = typeof fetchOverride === "string" && fetchOverride.trim() === "merged";
	// Acceptance seam (warren-ae00): WARREN_GH_FETCH_OVERRIDE=merged synthesizes
	// a stub token so reap's empty-token gate + tryOpenPr's empty-token gate
	// don't skip pr_open. The actual HTTP call short-circuits inside
	// openPullRequest before the token is read.
	const token = env.GITHUB_TOKEN ?? (overrideActive ? "stub-token" : "");
	return {
		enabled,
		token,
		warrenBaseUrl: env.WARREN_BASE_URL ?? null,
	};
}

function isFalsy(raw: string): boolean {
	const v = raw.trim().toLowerCase();
	return v === "0" || v === "false" || v === "no" || v === "off" || v === "";
}

/* ----------------------------------------------------------------------- */
/* PR-merge polling                                                         */
/* ----------------------------------------------------------------------- */

/**
 * `checkPullRequestMerged` — poll a GitHub PR's merge state for the PlanRun
 * coordinator (warren-9e4c). Pure helper: the caller decides what each
 * non-merged shape means (`open` = wait, `closed_unmerged` = fail the plan).
 *
 * Mirrors `openPullRequest`'s posture: direct REST call against
 * `GET /repos/:owner/:repo/pulls/:number`, `Authorization: Bearer <token>`
 * from `GITHUB_TOKEN`, fetch injected as a seam.
 */
export interface CheckPullRequestMergedInput {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly token: string;
	readonly fetch?: typeof fetch;
}

export type CheckPrMergedResult =
	| { readonly kind: "merged"; readonly mergedAt: string }
	| { readonly kind: "open" }
	| { readonly kind: "closed_unmerged" }
	| { readonly kind: "missing_token"; readonly message: string }
	| { readonly kind: "http_error"; readonly status: number; readonly message: string };

export async function checkPullRequestMerged(
	input: CheckPullRequestMergedInput,
): Promise<CheckPrMergedResult> {
	if (readGhFetchOverride() === "merged") {
		return { kind: "merged", mergedAt: new Date().toISOString() };
	}
	if (input.token === "") {
		return {
			kind: "missing_token",
			message: "GITHUB_TOKEN unset; cannot check pull request merge state",
		};
	}

	const fetchImpl = input.fetch ?? globalThis.fetch;
	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.number}`;

	let res: Response;
	try {
		res = await fetchImpl(url, { method: "GET", headers: buildHeaders(input.token) });
	} catch (err) {
		return {
			kind: "http_error",
			status: 0,
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status !== 200) {
		const text = await readText(res);
		return {
			kind: "http_error",
			status: res.status,
			message: `GET /pulls/${input.number} returned ${res.status}: ${truncate(text, 500)}`,
		};
	}

	const body = (await readJson(res)) as { merged_at?: unknown; state?: unknown } | null;
	const mergedAt = typeof body?.merged_at === "string" ? body.merged_at : null;
	if (mergedAt !== null) {
		return { kind: "merged", mergedAt };
	}
	const state = typeof body?.state === "string" ? body.state : "";
	if (state === "closed") {
		return { kind: "closed_unmerged" };
	}
	return { kind: "open" };
}

/**
 * `parsePullRequestUrl` — regex-parse `https://github.com/<owner>/<repo>/pull/<n>`.
 * Returns `null` on mismatch (e.g. GHE-hosted shapes) so the coordinator
 * treats them as "cannot verify merge" rather than "merged".
 */
const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePullRequestUrl(
	prUrl: string,
): { owner: string; repo: string; number: number } | null {
	const m = PR_URL_RE.exec(prUrl.trim());
	if (m === null) return null;
	const [, owner, repo, num] = m;
	if (owner === undefined || repo === undefined || num === undefined) return null;
	const n = Number.parseInt(num, 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	return { owner, repo, number: n };
}

/**
 * `parsePullRequestRef` — accept either a full GitHub PR URL
 * (`https://github.com/<owner>/<repo>/pull/<n>`) or the conventional
 * shorthand `<owner>/<repo>#<n>` shape that Plot `gh_pr` attachments
 * use (see `refPlaceholder('gh_pr')` in src/ui/src/pages/PlotDetail.tsx).
 * Returns `null` on mismatch so the merge handler treats it as
 * "cannot resolve" rather than "merged" (warren-8e39 / pl-0344 step 14).
 */
const PR_SHORT_RE = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;

export function parsePullRequestRef(
	ref: string,
): { owner: string; repo: string; number: number } | null {
	const trimmed = ref.trim();
	const viaUrl = parsePullRequestUrl(trimmed);
	if (viaUrl !== null) return viaUrl;
	const m = PR_SHORT_RE.exec(trimmed);
	if (m === null) return null;
	const [, owner, repo, num] = m;
	if (owner === undefined || repo === undefined || num === undefined) return null;
	const n = Number.parseInt(num, 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	return { owner, repo, number: n };
}

/* ----------------------------------------------------------------------- */
/* PR merge (warren-8e39 / pl-0344 step 14)                                 */
/* ----------------------------------------------------------------------- */

/**
 * `mergePullRequest` — click-to-merge a GitHub PR attached to a Plot
 * (warren-8e39 / pl-0344 step 14). Mirrors `openPullRequest`'s posture:
 * direct `PUT /repos/:owner/:repo/pulls/:number/merge`, fetch injected
 * as a seam, `GITHUB_TOKEN` auth.
 *
 * The result variants are tuned for what the PlotDetail merge UI cares
 * about:
 *   - `merged`            — 200 with `merged: true`. Caller schedules
 *                            a follow-up `refreshProjectClone` so the
 *                            local clone picks up the new merge commit.
 *   - `already_merged`    — 405/409 with "already merged" body. Same
 *                            net effect as `merged`; caller still
 *                            schedules the refresh (idempotent).
 *   - `not_mergeable`     — 405 (conflict / required reviews missing /
 *                            checks failing) or 409 (base SHA mismatch).
 *   - `missing_token`     — `GITHUB_TOKEN` unset on the server.
 *   - `rate_limited`      — 403 with `x-ratelimit-remaining: 0` or 429.
 *                            Surfaces the reset timestamp so the UI can
 *                            show a countdown.
 *   - `not_found`         — 404 (wrong owner/repo/number).
 *   - `network`           — fetch threw / non-HTTP failure.
 *   - `http_error`        — anything else (5xx etc.).
 */
export interface MergePullRequestInput {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly token: string;
	/** Optional commit message override; GitHub defaults are fine for most cases. */
	readonly commitMessage?: string;
	/** Merge method. Defaults to `merge` (matches GitHub's UI default). */
	readonly mergeMethod?: "merge" | "squash" | "rebase";
	readonly fetch?: typeof fetch;
}

export type MergePullRequestResult =
	| { readonly kind: "merged"; readonly sha: string }
	| { readonly kind: "already_merged" }
	| { readonly kind: "not_mergeable"; readonly message: string }
	| { readonly kind: "not_found"; readonly message: string }
	| { readonly kind: "missing_token"; readonly message: string }
	| {
			readonly kind: "rate_limited";
			readonly message: string;
			readonly resetAt: string | null;
	  }
	| { readonly kind: "network"; readonly message: string }
	| { readonly kind: "http_error"; readonly status: number; readonly message: string };

export async function mergePullRequest(
	input: MergePullRequestInput,
): Promise<MergePullRequestResult> {
	if (readGhFetchOverride() === "merged") {
		return { kind: "merged", sha: "0".repeat(40) };
	}
	if (input.token === "") {
		return {
			kind: "missing_token",
			message: "GITHUB_TOKEN unset; cannot merge pull request",
		};
	}

	const fetchImpl = input.fetch ?? globalThis.fetch;
	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.number}/merge`;
	const body: Record<string, string> = {
		merge_method: input.mergeMethod ?? "merge",
	};
	if (input.commitMessage !== undefined) {
		body.commit_message = input.commitMessage;
	}

	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "PUT",
			headers: buildHeaders(input.token),
			body: JSON.stringify(body),
		});
	} catch (err) {
		return {
			kind: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 200) {
		const payload = (await readJson(res)) as {
			merged?: unknown;
			sha?: unknown;
			message?: unknown;
		} | null;
		const merged = payload?.merged === true;
		const sha = typeof payload?.sha === "string" ? payload.sha : "";
		if (merged) {
			return { kind: "merged", sha };
		}
		const message = typeof payload?.message === "string" ? payload.message : "PR not merged";
		return { kind: "not_mergeable", message };
	}

	// Rate limit: GitHub surfaces 403 with x-ratelimit-remaining: 0, or 429.
	if (res.status === 429 || (res.status === 403 && isRateLimited(res))) {
		const reset = res.headers.get("x-ratelimit-reset");
		const resetAt =
			reset !== null && /^\d+$/.test(reset)
				? new Date(Number.parseInt(reset, 10) * 1000).toISOString()
				: null;
		const text = await readText(res);
		return {
			kind: "rate_limited",
			message: truncate(text, 500),
			resetAt,
		};
	}

	if (res.status === 404) {
		const text = await readText(res);
		return { kind: "not_found", message: truncate(text, 500) };
	}

	// 405 "Method Not Allowed" with `message: "Pull Request is not mergeable"`
	// is the standard "can't merge right now" shape. 409 is base SHA mismatch.
	// Both also cover "already merged" — distinguish via the body message.
	if (res.status === 405 || res.status === 409) {
		const payload = (await readJson(res)) as { message?: unknown } | null;
		const message =
			typeof payload?.message === "string" ? payload.message : `${res.status} from PUT /merge`;
		if (/already merged/i.test(message)) {
			return { kind: "already_merged" };
		}
		return { kind: "not_mergeable", message };
	}

	const text = await readText(res);
	return {
		kind: "http_error",
		status: res.status,
		message: `PUT /merge returned ${res.status}: ${truncate(text, 500)}`,
	};
}

function isRateLimited(res: Response): boolean {
	const remaining = res.headers.get("x-ratelimit-remaining");
	return remaining === "0";
}

/**
 * Retry-aware PR merge gate over the Forge seam (warren-63e7, plan pl-d1c9
 * step 11). Replaces the captured-token `checkPullRequestMerged` poller:
 * the old closure held one `GITHUB_TOKEN` captured at boot across a
 * multi-hour poll loop — the motivating bug of the whole Forge campaign
 * (forge-contract.md §4, §4.1), because an hourly App credential cannot
 * outlive the loop. The checker now consumes the boot-resolved `Forge`
 * (minted-per-operation credentials live inside the provider) and the gate
 * drives off `PullRequestState.lifecycle` / `mergedAt`.
 *
 * Poll result vocabulary (domain meaning, §3 — the forge reports
 * lifecycle, the domain decides what it means):
 *   - `merged` / `open` / `closed_unmerged` — the lifecycle arms.
 *   - `unparseable` — no forge owns the URL (foreign-host PR). Keeps the
 *     wait-indefinitely-on-manual-merge behaviour.
 *   - `forge_error` — the provider failed; `errorKind` is the
 *     `ForgeErrorKind` the domain switches on. Only `not_found` is fatal
 *     (`isFatalForgeError` in merge-gate.ts) — the PR is genuinely gone.
 *     Everything else keeps waiting, bounded by the merge-wait budget.
 *
 * Retry policy (transport-transient only, §3: semantic retry — waiting an
 * hour for a human to press merge — stays in merge-gate.ts):
 *   - `network` and 5xx `http_error` → retry up to `maxRetries` times.
 *   - `rate_limited` → retry, honoring the `Retry-After` hint (capped so a
 *     hostile header can't park the poller).
 *   - everything else returns immediately.
 *
 * The unauthorized policy (step body, warren-63e7 — do not re-litigate):
 *   - `unauthorized` / `forbidden` fire a LOUD once-per-repo `logger.warn`
 *     so the operator fixes credentials mid-run — the plan itself keeps
 *     waiting and never loses progress (plan risk 7).
 *   - `no_credential` KEEPS the old stall-and-log semantics: quiet, never
 *     fatal, no notice.
 */

import type {
	Forge,
	ForgeError,
	ForgeErrorKind,
	PullRequestRef,
	PullRequestState,
	RepoRef,
} from "../forge/contract.ts";

export type PrMergePollResult =
	| { readonly kind: "merged"; readonly mergedAt: string }
	| { readonly kind: "open" }
	| { readonly kind: "closed_unmerged" }
	| { readonly kind: "unparseable"; readonly detail: string }
	| { readonly kind: "forge_error"; readonly errorKind: ForgeErrorKind; readonly detail: string };

export type PrMergeChecker = (prUrl: string) => Promise<PrMergePollResult>;

/** Minimal structural logger — the domain cannot import src/server/types.ts. */
export interface PrMergeCheckerLogger {
	warn(obj: Record<string, unknown>, msg: string): void;
}

export interface CreatePrMergeCheckerInput {
	/** Boot-resolved forge (ServerDeps.forge) — never a per-tick instance. */
	readonly forge: Forge;
	/** Default 2 retries (3 total attempts). */
	readonly maxRetries?: number;
	/** Default 500ms between retries. Tests set this to 0. */
	readonly retryDelayMs?: number;
	/** Test seam for the delay. */
	readonly sleep?: (ms: number) => Promise<void>;
	/**
	 * Loud-notice sink for the unauthorized policy. A repo keys one notice
	 * per checker lifetime (the checker is boot-scoped, so per-repo ≈
	 * per-project).
	 */
	readonly logger?: PrMergeCheckerLogger;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

/**
 * A `Retry-After` hint above this is treated as broken, not patient — the
 * poller runs on the coordinator's tick and the merge-wait budget is the
 * real bound, so a multi-minute header would only stall the plan.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * The PR number is a legitimate seam DTO field (`PullRequestRef.number` —
 * "display + tracker cross-reference"), read here as the URL's trailing
 * numeric path segment. This is deliberately NOT a host grammar: the
 * forge-owned `parseRepoRef` decides whether the URL is owned at all, and
 * nothing here joins the number to a host path (forge-contract.md §0).
 */
const TRAILING_PR_NUMBER = /\/(\d+)(?:[/?#].*)?$/;

export function createPrMergeChecker(input: CreatePrMergeCheckerInput): PrMergeChecker {
	const { forge } = input;
	const sleep = input.sleep ?? defaultSleep;
	const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
	const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const noticedRepos = new Set<string>();

	const noticeUnauthorized = (refKey: string, error: ForgeError): void => {
		if (error.kind !== "unauthorized" && error.kind !== "forbidden") return;
		if (noticedRepos.has(refKey)) return;
		noticedRepos.add(refKey);
		input.logger?.warn(
			{
				repo: refKey,
				errorKind: error.kind,
				...(error.status !== undefined ? { status: error.status } : {}),
				detail: error.detail,
			},
			"plan_run.merge_check_unauthorized",
		);
	};

	return async function poll(prUrl: string): Promise<PrMergePollResult> {
		const target = resolvePollTarget(forge, prUrl);
		if (target.kind === "unparseable") return target;

		let last: ForgeError = { kind: "network", detail: "no result" };
		for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
			const result = await forge.getPullRequest(target.ref, target.pr);
			if (result.ok) return mapLifecycle(result.value);
			last = result.error;
			if (!isTransient(result.error)) {
				noticeUnauthorized(target.ref.key, result.error);
				break;
			}
			const delayMs = retryDelayFor(result.error, retryDelayMs);
			if (attempt < maxRetries && delayMs > 0) {
				await sleep(delayMs);
			}
		}
		return { kind: "forge_error", errorKind: last.kind, detail: last.detail };
	};
}

type PollTarget =
	| { readonly kind: "unparseable"; readonly detail: string }
	| { readonly kind: "resolved"; readonly ref: RepoRef; readonly pr: PullRequestRef };

/**
 * Route a stored PR URL to its forge. A null `parseRepoRef` (foreign-host
 * PR) keeps the wait-indefinitely-on-manual-merge behaviour, exactly as
 * before.
 */
function resolvePollTarget(forge: Forge, prUrl: string): PollTarget {
	const ref = forge.parseRepoRef(prUrl);
	if (ref === null) {
		return { kind: "unparseable", detail: `no forge owns pull request url: ${prUrl}` };
	}
	const number = TRAILING_PR_NUMBER.exec(prUrl.trim())?.[1];
	if (number === undefined) {
		return { kind: "unparseable", detail: `no pull request number in url: ${prUrl}` };
	}
	const pr: PullRequestRef = {
		forge: ref.forge,
		key: `${ref.key}#${number}`,
		number: Number.parseInt(number, 10),
		webUrl: prUrl,
	};
	return { kind: "resolved", ref, pr };
}

/** Map the provider-neutral lifecycle onto the gate's poll vocabulary. */
function mapLifecycle(state: PullRequestState): PrMergePollResult {
	if (state.lifecycle === "merged") {
		// mergedAt non-null is the truth source (GitHubForge only reports
		// `merged` when it is set); the Date.now fallback covers a provider
		// that breaks that rule.
		return { kind: "merged", mergedAt: new Date(state.mergedAt ?? Date.now()).toISOString() };
	}
	return state.lifecycle === "closed_unmerged" ? { kind: "closed_unmerged" } : { kind: "open" };
}

function isTransient(error: ForgeError): boolean {
	if (error.kind === "rate_limited" || error.kind === "network") return true;
	if (error.kind !== "http_error") return false;
	return error.status === undefined || error.status >= 500;
}

function retryDelayFor(error: ForgeError, fallbackMs: number): number {
	if (error.kind !== "rate_limited" || error.retryAfterMs === undefined) return fallbackMs;
	return Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

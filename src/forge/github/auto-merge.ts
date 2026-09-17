/**
 * The GitHub auto-merge arm of the Forge seam (plan pl-92a3, step 3).
 *
 * `armAutoMerge` drives GitHub's `enablePullRequestAutoMerge` GraphQL
 * mutation — the REST surface has no equivalent — so the flow spans two
 * transports: one REST read of the pull request (state, the existing
 * auto-merge request, mergeability, the GraphQL node id) and, only when
 * that read says arming is possible, one GraphQL mutation (./graphql.ts).
 *
 * Classification is the contract's closed refusal vocabulary
 * (docs/design/forge-auto-merge.md §2.1): every GitHub answer, including a
 * transport failure, maps to exactly one reason, and a transport failure
 * lands as `unknown` with its `ForgeErrorKind` named in the message, so the
 * caller switches on one taxonomy. `mergeability_unsettled` is the only
 * retryable class (§2.4): GitHub computes mergeability asynchronously, so
 * an UNKNOWN (or unstable, or absent) state waits on the 1s/2s/4s/8s
 * schedule and re-reads — at most about fifteen seconds — before refusing.
 *
 * `provider.ts` sits at its file-size ceiling, so this module owns the whole
 * arm flow; the provider hands over its token source, fetch seam, and slug.
 */

import type {
	ArmAutoMergeResult,
	AutoMergeMethod,
	AutoMergeRefusalReason,
	PullRequestRef,
} from "../contract.ts";
import type { GitHubHttpError } from "./errors.ts";
import { type GitHubGraphQLError, requestGitHubGraphQL } from "./graphql.ts";
import { GITHUB_API_BASE } from "./headers.ts";
import { requestGitHub } from "./http.ts";
import { readJson } from "./readers.ts";
import type { GitHubRetryOptions } from "./retry.ts";
import type { GitHubForgeTokenSource } from "./token-source.ts";

/** Subsystem User-Agent, mirroring the REST provider's. */
const USER_AGENT = "warren-forge-github";

/** The §2.4 wait schedule: four waits (1s, 2s, 4s, 8s) cap the arm at ~15s. */
const MERGEABILITY_WAIT_SCHEDULE_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** `merge` method → the GraphQL `MergeMethod` enum value. */
const GRAPHQL_MERGE_METHODS: Readonly<Record<AutoMergeMethod, "MERGE" | "REBASE" | "SQUASH">> = {
	squash: "SQUASH",
	merge: "MERGE",
	rebase: "REBASE",
};

/** The arming mutation (§1): warren asks; GitHub owns the merge. */
const ENABLE_AUTO_MERGE_MUTATION = `mutation($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) {
    clientMutationId
  }
}`;

/** Mutation-error message → refusal reason, evaluated in order (first match wins). */
const MUTATION_ERROR_CLASSIFICATIONS: ReadonlyArray<{
	readonly pattern: RegExp;
	readonly reason: AutoMergeRefusalReason;
}> = [
	{ pattern: /auto merge is not allowed/i, reason: "repo_auto_merge_disabled" },
	{ pattern: /in clean status/i, reason: "clean_status" },
	{
		// The App-permission and PAT-scope refusals: GitHub's wording for "the
		// credential may see the PR but may not arm it" (§6).
		pattern: /resource not accessible by integration|scope|forbidden/i,
		reason: "insufficient_permission",
	},
	{ pattern: /mergeab(?:le|ility)/i, reason: "mergeability_unsettled" },
	{ pattern: /closed|merged/i, reason: "not_open" },
];

/** The REST fields the arm reads (GET /repos/:slug/pulls/:number). */
interface GitHubArmPrJson {
	readonly state?: unknown;
	readonly merged_at?: unknown;
	readonly draft?: unknown;
	readonly auto_merge?: unknown;
	readonly mergeable_state?: unknown;
	readonly node_id?: unknown;
}

export interface ArmGitHubAutoMergeInput {
	/** The shared credential source (§4): minted immediately before each call. */
	readonly tokens: GitHubForgeTokenSource;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** `<owner>/<repo>` — the provider-owned slug, destructured from the RepoRef key. */
	readonly slug: string;
	readonly pr: PullRequestRef;
	readonly method: AutoMergeMethod;
	/**
	 * Test seam: drives BOTH the §2.4 wait schedule and the transport retry
	 * delays, so no test waits on a clock. Defaults to a real sleep.
	 */
	readonly sleep?: (ms: number) => Promise<void>;
}

function refused(reason: AutoMergeRefusalReason, message: string): ArmAutoMergeResult {
	return { ok: false, error: { reason, message } };
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One sleep seam drives the transport retry delays too (see ArmGitHubAutoMergeInput.sleep). */
function retryOptionsFor(input: ArmGitHubAutoMergeInput): GitHubRetryOptions {
	return input.sleep !== undefined ? { sleep: input.sleep } : {};
}

/**
 * Classify an HTTP-level failure: a plain 403 is `insufficient_permission`
 * (§6 — the App-permission/PAT-scope refusal); every other transport failure
 * is `unknown` with its `ForgeErrorKind` named in the message.
 */
function refusedFromHttpError(error: GitHubHttpError, call: string): ArmAutoMergeResult {
	if (error.kind === "forbidden") {
		return refused("insufficient_permission", `${call}: ${error.message}`);
	}
	return refused("unknown", `${call} failed (${error.kind}): ${error.message}`);
}

/** One REST read of the pull request; the arm's state, idempotency, and mergeability input. */
async function readPrForArm(
	input: ArmGitHubAutoMergeInput,
	token: string,
): Promise<{ ok: true; json: GitHubArmPrJson } | { ok: false; error: GitHubHttpError }> {
	const result = await requestGitHub({
		url: `${GITHUB_API_BASE}/repos/${input.slug}/pulls/${input.pr.number}`,
		method: "GET",
		token,
		userAgent: USER_AGENT,
		context: `GET /pulls/${input.pr.number}`,
		fetch: input.fetch,
		retry: retryOptionsFor(input),
	});
	if (!result.ok) return { ok: false, error: result.error };
	const body = (await readJson(result.response)) as GitHubArmPrJson | null;
	if (body === null) {
		return {
			ok: false,
			error: {
				kind: "http_error",
				status: 200,
				retryAfterMs: null,
				message: `GET /pulls/${input.pr.number} returned an unreadable body`,
			},
		};
	}
	return { ok: true, json: body };
}

type PrReadVerdict =
	| { status: "settled"; json: GitHubArmPrJson }
	| { status: "unsettled" }
	| { status: "refused"; result: ArmAutoMergeResult };

/**
 * Classify one REST read (§2.1/§2.4): state first — a closed, merged, or
 * draft PR never arms — then the existing auto-merge request (idempotency),
 * then mergeability. `unknown`/`unstable` (or an absent state — GitHub
 * computes mergeability asynchronously) is the retryable class; `dirty` is a
 * conflict the healer paths own, not this one (§2.4 step 4).
 */
function classifyPrRead(pr: PullRequestRef, json: GitHubArmPrJson): PrReadVerdict {
	if (json.merged_at != null) {
		return {
			status: "refused",
			result: refused("not_open", `pull request #${pr.number} is merged`),
		};
	}
	if (json.state === "closed") {
		return {
			status: "refused",
			result: refused("not_open", `pull request #${pr.number} is closed`),
		};
	}
	if (json.draft === true) {
		return {
			status: "refused",
			result: refused("not_open", `pull request #${pr.number} is a draft`),
		};
	}
	if (json.auto_merge != null) {
		return { status: "refused", result: { ok: true, value: { outcome: "already_armed" } } };
	}
	const mergeableState =
		typeof json.mergeable_state === "string" ? json.mergeable_state.toLowerCase() : "";
	if (mergeableState === "dirty") {
		return {
			status: "refused",
			result: refused(
				"unknown",
				`pull request #${pr.number} is conflicting (mergeable_state dirty) — warren does not repair conflicts here`,
			),
		};
	}
	if (mergeableState === "" || mergeableState === "unknown" || mergeableState === "unstable") {
		return { status: "unsettled" };
	}
	return { status: "settled", json };
}

type SettledRead =
	| { status: "settled"; json: GitHubArmPrJson }
	| { status: "refused"; result: ArmAutoMergeResult };

/**
 * Read the pull request until mergeability settles (§2.4): while the state
 * reads unknown/unstable, wait on the schedule and re-read. `attempt` is the
 * number of waits done so far; past the fourth, the arm refuses
 * `mergeability_unsettled` and never delays reap past the bound.
 */
async function settlePrRead(
	input: ArmGitHubAutoMergeInput,
	token: string,
	attempt: number,
): Promise<SettledRead> {
	const read = await readPrForArm(input, token);
	if (!read.ok) {
		return {
			status: "refused",
			result: refusedFromHttpError(read.error, `GET /pulls/${input.pr.number}`),
		};
	}
	const verdict = classifyPrRead(input.pr, read.json);
	if (verdict.status === "unsettled") {
		const wait = MERGEABILITY_WAIT_SCHEDULE_MS[attempt];
		if (wait === undefined) {
			return {
				status: "refused",
				result: refused(
					"mergeability_unsettled",
					`pull request #${input.pr.number} mergeability never settled past the §2.4 schedule`,
				),
			};
		}
		await (input.sleep ?? defaultSleep)(wait);
		return settlePrRead(input, token, attempt + 1);
	}
	return verdict;
}

/** Classify the mutation's GraphQL-error arm into the closed vocabulary. */
function classifyGraphQLErrors(errors: readonly GitHubGraphQLError[]): ArmAutoMergeResult {
	const message = errors[0]?.message ?? "GraphQL error without a message";
	// Idempotency (§8): an already-armed PR answers with an "already" message,
	// which is the success we wanted — no second armer, no double arm.
	if (/already/i.test(message)) return { ok: true, value: { outcome: "already_armed" } };
	for (const rule of MUTATION_ERROR_CLASSIFICATIONS) {
		if (rule.pattern.test(message)) return refused(rule.reason, message);
	}
	if (errors.some((e) => e.type === "FORBIDDEN")) {
		return refused("insufficient_permission", message);
	}
	return refused("unknown", message);
}

/** Run the arming mutation against the PR's GraphQL node id and classify the answer. */
async function armMutation(
	input: ArmGitHubAutoMergeInput,
	token: string,
	json: GitHubArmPrJson,
): Promise<ArmAutoMergeResult> {
	const nodeId = typeof json.node_id === "string" ? json.node_id : "";
	if (nodeId === "") {
		return refused(
			"unknown",
			`GET /pulls/${input.pr.number} returned no node_id for the GraphQL mutation`,
		);
	}
	const result = await requestGitHubGraphQL({
		query: ENABLE_AUTO_MERGE_MUTATION,
		variables: {
			input: { pullRequestId: nodeId, mergeMethod: GRAPHQL_MERGE_METHODS[input.method] },
		},
		token,
		userAgent: USER_AGENT,
		context: "mutation enablePullRequestAutoMerge",
		fetch: input.fetch,
		retry: retryOptionsFor(input),
	});
	if (result.ok) {
		const data = result.data as { enablePullRequestAutoMerge?: unknown } | null;
		if (data?.enablePullRequestAutoMerge != null) {
			return { ok: true, value: { outcome: "armed" } };
		}
		return refused("unknown", "mutation enablePullRequestAutoMerge returned no payload");
	}
	if (result.error.kind === "http") {
		return refusedFromHttpError(result.error.error, "mutation enablePullRequestAutoMerge");
	}
	return classifyGraphQLErrors(result.error.errors);
}

/**
 * Arm auto-merge on one GitHub pull request (the shared arm behind both the
 * PAT and App providers). Never throws; every answer — including a transport
 * failure — is an `ArmAutoMergeResult` inside the closed vocabulary.
 */
export async function armGitHubAutoMerge(
	input: ArmGitHubAutoMergeInput,
): Promise<ArmAutoMergeResult> {
	const minted = await input.tokens.mint();
	if (!minted.ok) {
		return refused(
			"unknown",
			`arm skipped: no usable credential (${minted.error.kind}) — ${minted.error.detail}`,
		);
	}
	const settled = await settlePrRead(input, minted.value.secret, 0);
	if (settled.status === "refused") return settled.result;
	return armMutation(input, minted.value.secret, settled.json);
}

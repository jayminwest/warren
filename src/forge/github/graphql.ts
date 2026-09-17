/**
 * GitHub GraphQL transport (plan pl-92a3 step 3) — the fetch boundary for
 * the GraphQL endpoint, a sibling of the REST core (./http.ts).
 *
 * GitHub exposes enable-auto-merge only through GraphQL, so the forge needs
 * a second transport; it reuses the REST core's pieces rather than growing
 * its own copies: the canonical header set (headers.ts), the retry policy
 * (retry.ts — network, 5xx, and rate limits retry in-band, other 4xx are
 * fatal), the error classifier (errors.ts), and the fail-soft readers
 * (readers.ts). The endpoint derives from the same `GITHUB_API_BASE` the
 * REST transport uses, so one fetch seam — or one stub server — covers both.
 *
 * The failure mode the REST core never sees: HTTP 200 carrying a non-empty
 * `errors` array. That response IS a failure, a semantic one the caller
 * classifies, so it returns on the error arm with the parsed errors instead
 * of as an HTTP error.
 */

import { classifyGitHubHttpError, type GitHubHttpError, networkError } from "./errors.ts";
import { buildGitHubHeaders, GITHUB_API_BASE } from "./headers.ts";
import { readJson, readText, truncate } from "./readers.ts";
import { type GitHubRetryOptions, withGitHubRetry } from "./retry.ts";

/** The GraphQL endpoint, derived from the same base the REST transport uses. */
export const GITHUB_GRAPHQL_URL = `${GITHUB_API_BASE}/graphql`;

/** One GraphQL API error, as GitHub returns it inside the 200 envelope. */
export interface GitHubGraphQLError {
	readonly message: string;
	readonly type?: string;
}

/** One GraphQL failure: an HTTP-level error, or a 200 with a non-empty `errors` array. */
export type GitHubGraphQLFailure =
	| { readonly kind: "http"; readonly error: GitHubHttpError }
	| { readonly kind: "graphql"; readonly errors: readonly GitHubGraphQLError[] };

export type GitHubGraphQLResult =
	| { readonly ok: true; readonly data: unknown }
	| { readonly ok: false; readonly error: GitHubGraphQLFailure };

export interface GitHubGraphQLRequestInput {
	/** The GraphQL document. */
	readonly query: string;
	/** JSON-serializable variables; omitted when undefined. */
	readonly variables?: unknown;
	readonly token: string;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Subsystem User-Agent override (see headers.ts). */
	readonly userAgent?: string;
	/** Short call-site label folded into error messages. */
	readonly context: string;
	/** Retry tuning; transient failures retry by default. */
	readonly retry?: GitHubRetryOptions;
}

/** Cap on response-body text folded into an error message (mirrors ./http.ts). */
const ERROR_BODY_MAX_CHARS = 500;

/** Narrow one raw `errors` row to `{message, type}`; a row without a message string drops. */
function parseGraphQLError(raw: unknown): GitHubGraphQLError | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.message !== "string") return null;
	return typeof obj.type === "string"
		? { message: obj.message, type: obj.type }
		: { message: obj.message };
}

/**
 * Execute one GraphQL request: build the canonical headers, POST, classify a
 * non-2xx response through the shared classifier, retry transient failures
 * per the module policy, and treat a 200 with a non-empty `errors` array as
 * a failure the caller classifies. Never throws — a thrown fetch surfaces as
 * a `network` error.
 */
export async function requestGitHubGraphQL(
	input: GitHubGraphQLRequestInput,
): Promise<GitHubGraphQLResult> {
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const headers = buildGitHubHeaders(input.token, {
		...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
	});
	const init: RequestInit = {
		method: "POST",
		headers,
		body: JSON.stringify({
			query: input.query,
			...(input.variables !== undefined ? { variables: input.variables } : {}),
		}),
	};
	const retried = await withGitHubRetry(async () => {
		let res: Response;
		try {
			res = await fetchImpl(GITHUB_GRAPHQL_URL, init);
		} catch (err) {
			return { ok: false, error: networkError(err, input.context) };
		}
		if (!res.ok) {
			const text = truncate(await readText(res), ERROR_BODY_MAX_CHARS);
			return {
				ok: false,
				error: classifyGitHubHttpError(res.status, res.headers, text, input.context),
			};
		}
		return { ok: true, value: res };
	}, input.retry ?? {});
	if (!retried.ok) return { ok: false, error: { kind: "http", error: retried.error } };
	const body = (await readJson(retried.value)) as { data?: unknown; errors?: unknown } | null;
	if (body === null) {
		return {
			ok: false,
			error: {
				kind: "http",
				error: {
					kind: "http_error",
					status: 200,
					retryAfterMs: null,
					message: `${input.context} returned an unreadable body`,
				},
			},
		};
	}
	const rawErrors = Array.isArray(body.errors) ? body.errors : [];
	if (rawErrors.length > 0) {
		const errors = rawErrors
			.map(parseGraphQLError)
			.filter((e): e is GitHubGraphQLError => e !== null);
		return { ok: false, error: { kind: "graphql", errors } };
	}
	return { ok: true, data: body.data };
}

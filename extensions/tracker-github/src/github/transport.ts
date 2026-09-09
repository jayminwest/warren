import { readFile } from "node:fs/promises";
import type { GitHubConfig } from "../config.ts";
import { object, TrackerFailure } from "../errors.ts";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Redirects are never followed with a credential, including GitHub's moved-repo redirects. */
export class GitHubTransport {
	constructor(
		private readonly config: GitHubConfig,
		private readonly fetchImpl: Fetch = fetch,
	) {}

	private async token(): Promise<string> {
		if (this.config.token) return this.config.token;
		try {
			const value = (await readFile(this.config.tokenFile ?? "", "utf8")).trim();
			if (value) return value;
		} catch {
			/* A credential-source failure is not a reason to issue an anonymous request. */
		}
		throw new TrackerFailure("credential_unavailable", "GitHub credential is unavailable", 503);
	}

	async request(
		url: string,
		method: "GET" | "POST" | "PATCH",
		body?: unknown,
	): Promise<{ body: unknown; headers: Headers }> {
		const token = await this.token();
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				redirect: "error",
				signal: AbortSignal.timeout(this.config.timeoutMs),
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new TrackerFailure("upstream_unreachable", "GitHub request failed or timed out");
		}
		if (!response.ok) throw this.failure(response);
		try {
			return { body: await response.json(), headers: response.headers };
		} catch {
			throw new TrackerFailure("upstream_invalid_response", "GitHub returned invalid JSON");
		}
	}

	private failure(response: Response): TrackerFailure {
		const rateLimited =
			response.status === 429 ||
			(response.status === 403 &&
				(response.headers.has("retry-after") ||
					response.headers.get("x-ratelimit-remaining") === "0"));
		if (rateLimited) {
			const reset = Number(response.headers.get("x-ratelimit-reset"));
			const retry =
				response.headers.get("retry-after") ??
				(reset > 0 ? String(Math.max(1, Math.ceil(reset - Date.now() / 1000))) : "60");
			return new TrackerFailure("upstream_rate_limited", "GitHub rate limit reached", 429, retry);
		}
		if (response.status === 404)
			return new TrackerFailure(
				"upstream_not_found",
				"GitHub resource was not found or is not accessible",
				404,
			);
		if (response.status === 401 || response.status === 403)
			return new TrackerFailure(
				"upstream_unauthorized",
				"GitHub rejected the adapter credential or its permissions",
			);
		return new TrackerFailure("upstream_error", `GitHub returned HTTP ${response.status}`);
	}

	async graphql(
		query: string,
		variables: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const { body } = await this.request(this.config.graphqlUrl, "POST", { query, variables });
		const envelope = object(body);
		// Partial data is unsafe for a work queue: never silently broaden filters or omit pages.
		if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
			const rate = envelope.errors.some((value: unknown) => object(value).type === "RATE_LIMITED");
			throw new TrackerFailure(
				rate ? "upstream_rate_limited" : "upstream_graphql_error",
				"GitHub GraphQL did not return a complete result",
				rate ? 429 : 502,
				rate ? "60" : undefined,
			);
		}
		return object(envelope.data);
	}
}

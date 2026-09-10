import { timingSafeEqual } from "node:crypto";
import type { GitHubConfig } from "./config.ts";
import type { DispatchStore } from "./dispatch/store.ts";
import { TrackerFailure } from "./errors.ts";
import { GitHubClient } from "./github/client.ts";

export const CAPABILITIES = {
	supportsPlans: false,
	supportsMetadata: false,
	supportsScheduledIssues: false,
	isGitNative: false,
	supportsIssueListing: true,
} as const;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}
function failure(error: unknown): Response {
	const safe =
		error instanceof TrackerFailure
			? error
			: new TrackerFailure("internal_error", "Tracker request failed", 500);
	return json(
		{ error: { code: safe.code, message: safe.message } },
		safe.status,
		safe.retryAfter ? { "retry-after": safe.retryAfter } : {},
	);
}
function authorized(request: Request, token?: string): boolean {
	if (token === undefined) return true;
	const actual = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createHandler(
	config: GitHubConfig,
	client = new GitHubClient(config),
	store?: DispatchStore,
): (request: Request) => Promise<Response> {
	return async (request) => {
		if (!authorized(request, config.bearer))
			return failure(new TrackerFailure("unauthorized", "Missing or invalid tracker bearer", 401));
		const url = new URL(request.url);
		const path = url.pathname;
		try {
			if (request.method === "GET" && path === "/capabilities")
				return json({ protocolVersion: "warren-tracker/v1", capabilities: CAPABILITIES });
			if (request.method === "GET" && path === "/issues")
				return json({ issues: await client.listIssues() });
			if (request.method === "GET" && path === "/issue-statuses") {
				return json({
					statuses: Object.fromEntries(
						(await client.listIssues(false)).map((issue) => [issue.id, issue.status]),
					),
				});
			}
			if (request.method === "GET" && path === "/dispatches")
				return json({ automatic: store !== undefined, dispatches: store?.list() ?? [] });
			const match = /^\/issues\/([^/]+)(\/close)?$/.exec(path);
			if (match) {
				let id: string;
				try {
					id = decodeURIComponent(match[1] ?? "");
				} catch {
					throw new TrackerFailure(
						"invalid_issue_id",
						"Issue id is not valid percent-encoding",
						400,
					);
				}
				if (request.method === "GET" && !match[2]) return json(await client.getIssue(id));
				if (request.method === "POST" && match[2]) {
					await client.closeIssue(id);
					return json({ ok: true });
				}
			}
			return failure(
				new TrackerFailure("capability_not_supported", "Unsupported tracker operation", 404),
			);
		} catch (error) {
			return failure(error);
		}
	};
}

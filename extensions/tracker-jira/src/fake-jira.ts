/**
 * FakeJira: enough of the Jira Cloud REST v3 surface to drive this
 * tracker, in memory.
 *
 * It exists because the useful test of this package is not "does the code
 * run" but "does the tracker survive the warren-tracker/v1 conformance
 * suite", and that needs a Jira on the other side. It is a `fetch`-shaped
 * function, so it drops straight into {@link JiraClient}'s transport seam
 * with no socket in the way.
 *
 * The payload shapes are transcribed from Atlassian's documented v3
 * responses. That is exactly the assumption this package cannot verify
 * without a real instance, so treat FakeJira as a statement of what this
 * tracker EXPECTS Jira to return, and the first live run against a real
 * site as the thing that confirms or corrects it.
 */

export interface FakeJiraIssue {
	key: string;
	summary?: string;
	/** ADF node tree, or a plain string. */
	description?: unknown;
	status: string;
	/** Jira's status category key: `new`, `indeterminate` or `done`. */
	statusCategory: "new" | "indeterminate" | "done";
	/** Keys of issues that block this one. */
	blockedBy?: string[];
}

export interface FakeJiraTransition {
	id: string;
	name: string;
	toStatus: string;
	toCategory: "new" | "indeterminate" | "done";
}

export interface FakeJiraOptions {
	readonly issues: readonly FakeJiraIssue[];
	/** Transitions offered from any non-terminal status. */
	readonly transitions?: readonly FakeJiraTransition[];
	/** Issues per page, so the client's pagination loop is exercised. */
	readonly pageSize?: number;
	/** Fail every call with this status, for the error-mapping tests. */
	readonly failWith?: { readonly status: number; readonly retryAfter?: string };
}

const DEFAULT_TRANSITIONS: readonly FakeJiraTransition[] = [
	{ id: "11", name: "In Progress", toStatus: "In Progress", toCategory: "indeterminate" },
	{ id: "31", name: "Done", toStatus: "Done", toCategory: "done" },
	// A second terminal transition, so the tests can tell "the configured
	// name won" apart from "the done category won".
	{ id: "41", name: "Reject", toStatus: "Rejected", toCategory: "done" },
];

export interface FakeJira {
	/** Drop-in for `fetch`, to hand {@link JiraClient}. */
	readonly fetchImpl: typeof fetch;
	/** Live view of the issues, so a test can assert what a close did. */
	readonly issues: Map<string, FakeJiraIssue>;
	/** Every request as `METHOD path`, in order. */
	readonly calls: string[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function issueBody(issue: FakeJiraIssue): unknown {
	return {
		key: issue.key,
		fields: {
			summary: issue.summary ?? null,
			description: issue.description ?? null,
			status: { name: issue.status, statusCategory: { key: issue.statusCategory } },
			issuelinks: (issue.blockedBy ?? []).map((key) => ({
				type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
				inwardIssue: { key },
			})),
		},
	};
}

const ISSUE = /^\/rest\/api\/3\/issue\/([^/]+)$/;
const TRANSITIONS = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/;

export function createFakeJira(options: FakeJiraOptions): FakeJira {
	const issues = new Map(options.issues.map((i) => [i.key, { ...i }]));
	const transitions = options.transitions ?? DEFAULT_TRANSITIONS;
	const pageSize = options.pageSize ?? 100;
	const calls: string[] = [];

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url.pathname}`);

		if (options.failWith !== undefined) {
			const headers: Record<string, string> =
				options.failWith.retryAfter === undefined
					? {}
					: { "retry-after": options.failWith.retryAfter };
			return json({ errorMessages: ["fake jira failure"] }, options.failWith.status, headers);
		}

		const issueMatch = ISSUE.exec(url.pathname);
		if (method === "GET" && issueMatch !== null) {
			const issue = issues.get(decodeURIComponent(issueMatch[1] ?? ""));
			if (issue === undefined) return json({ errorMessages: ["Issue does not exist"] }, 404);
			return json(issueBody(issue));
		}

		if (method === "GET" && url.pathname === "/rest/api/3/search/jql") {
			return searchPage(url);
		}

		const transitionMatch = TRANSITIONS.exec(url.pathname);
		if (transitionMatch !== null) {
			const key = decodeURIComponent(transitionMatch[1] ?? "");
			const issue = issues.get(key);
			if (issue === undefined) return json({ errorMessages: ["Issue does not exist"] }, 404);
			if (method === "GET") {
				// Jira offers no transitions out of a terminal status in the
				// default workflow, which is what makes the already-done read
				// the only honest answer for an idempotent close.
				const offered = issue.statusCategory === "done" ? [] : transitions;
				return json({
					transitions: offered.map((t) => ({
						id: t.id,
						name: t.name,
						to: { name: t.toStatus, statusCategory: { key: t.toCategory } },
					})),
				});
			}
			const body = (await new Response(init?.body as BodyInit).json()) as {
				transition?: { id?: string };
			};
			const chosen = transitions.find((t) => t.id === body.transition?.id);
			if (chosen === undefined) return json({ errorMessages: ["Transition is not valid"] }, 400);
			issue.status = chosen.toStatus;
			issue.statusCategory = chosen.toCategory;
			return new Response(null, { status: 204 });
		}

		return json({ errorMessages: [`no fake route: ${method} ${url.pathname}`] }, 404);
	}) as unknown as typeof fetch;

	function searchPage(url: URL): Response {
		const all = [...issues.values()];
		const start = Number(url.searchParams.get("nextPageToken") ?? "0");
		const slice = all.slice(start, start + pageSize);
		const next = start + pageSize;
		const isLast = next >= all.length;
		return json({
			issues: slice.map((i) => ({
				key: i.key,
				fields: { status: { name: i.status, statusCategory: { key: i.statusCategory } } },
			})),
			isLast,
			...(isLast ? {} : { nextPageToken: String(next) }),
		});
	}

	return { fetchImpl, issues, calls };
}

/** The fixture the tests and the conformance run share. */
export const SAMPLE_ISSUES: readonly FakeJiraIssue[] = [
	{
		key: "WAR-1",
		summary: "Redis connection pool leaks under load",
		description: {
			type: "doc",
			version: 1,
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Connections are never returned after a timeout." },
					],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Reproduced on staging twice." }],
				},
			],
		},
		status: "To Do",
		statusCategory: "new",
		blockedBy: ["WAR-2"],
	},
	{ key: "WAR-2", summary: "Upgrade the redis client", status: "In Progress", statusCategory: "indeterminate" },
	{ key: "WAR-3", summary: "Old migration cleanup", status: "Done", statusCategory: "done" },
];

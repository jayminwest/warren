/**
 * The transport, driven directly rather than through the handler.
 *
 * The cases here are the ones the server tests cannot reach: what the
 * request actually carries to Jira, and how the client reads a response
 * that is not a plain JSON body. This is the layer most likely to be
 * wrong against a real site, so it is worth pinning on its own.
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { JiraApiError, JiraClient } from "./client.ts";

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | undefined;
}

function recordingFetch(responder: (request: RecordedRequest) => Response): {
	fetchImpl: typeof fetch;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
			headers[key.toLowerCase()] = value;
		}
		const record: RecordedRequest = {
			url: typeof input === "string" ? input : input.toString(),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		requests.push(record);
		return responder(record);
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

const BASE = {
	JIRA_BASE_URL: "https://acme.atlassian.net",
	JIRA_EMAIL: "bot@acme.example",
	JIRA_API_TOKEN: "token-123",
	JIRA_JQL: "project = WAR",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("JiraClient request shape", () => {
	test("sends basic auth built from the email and token", async () => {
		const { fetchImpl, requests } = recordingFetch(() => json({ key: "WAR-1" }));
		await new JiraClient(loadConfig(BASE), fetchImpl).getIssue("WAR-1");
		expect(requests[0]?.headers.authorization).toBe(
			`Basic ${Buffer.from("bot@acme.example:token-123").toString("base64")}`,
		);
	});

	test("sends a bearer when that is how the container is configured", async () => {
		const { fetchImpl, requests } = recordingFetch(() => json({ key: "WAR-1" }));
		const config = loadConfig({
			...BASE,
			JIRA_EMAIL: undefined,
			JIRA_API_TOKEN: undefined,
			JIRA_BEARER: "oauth-abc",
		});
		await new JiraClient(config, fetchImpl).getIssue("WAR-1");
		expect(requests[0]?.headers.authorization).toBe("Bearer oauth-abc");
	});

	test("asks for only the fields it maps, and escapes the key in the path", async () => {
		const { fetchImpl, requests } = recordingFetch(() => json({ key: "a/b" }));
		await new JiraClient(loadConfig(BASE), fetchImpl).getIssue("a/b");
		expect(requests[0]?.url).toBe(
			"https://acme.atlassian.net/rest/api/3/issue/a%2Fb?fields=summary,description,status,issuelinks",
		);
	});

	test("posts the transition id in the body Jira expects", async () => {
		const { fetchImpl, requests } = recordingFetch(() => new Response(null, { status: 204 }));
		await new JiraClient(loadConfig(BASE), fetchImpl).applyTransition("WAR-1", "31");
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ transition: { id: "31" } });
	});
});

describe("JiraClient.issueStatuses", () => {
	test("carries the configured JQL and page size on every page", async () => {
		let page = 0;
		const { fetchImpl, requests } = recordingFetch(() => {
			page += 1;
			return page === 1
				? json({ issues: [{ key: "WAR-1", fields: { status: { name: "To Do" } } }], nextPageToken: "t2" })
				: json({ issues: [{ key: "WAR-2", fields: { status: { name: "Done" } } }], isLast: true });
		});
		const statuses = await new JiraClient(loadConfig(BASE), fetchImpl).issueStatuses();

		expect(statuses).toEqual({ "WAR-1": "To Do", "WAR-2": "Done" });
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			const url = new URL(request.url);
			expect(url.searchParams.get("jql")).toBe("project = WAR");
			expect(url.searchParams.get("maxResults")).toBe("100");
		}
		expect(new URL(requests[0]?.url ?? "").searchParams.get("nextPageToken")).toBeNull();
		expect(new URL(requests[1]?.url ?? "").searchParams.get("nextPageToken")).toBe("t2");
	});

	test("stops on isLast even when the page still carries a token", async () => {
		const { fetchImpl, requests } = recordingFetch(() =>
			json({ issues: [{ key: "WAR-1", fields: { status: { name: "To Do" } } }], isLast: true, nextPageToken: "t2" }),
		);
		await new JiraClient(loadConfig(BASE), fetchImpl).issueStatuses();
		expect(requests).toHaveLength(1);
	});

	test("records an empty status for an issue whose workflow reports none", async () => {
		const { fetchImpl } = recordingFetch(() => json({ issues: [{ key: "WAR-1" }], isLast: true }));
		expect(await new JiraClient(loadConfig(BASE), fetchImpl).issueStatuses()).toEqual({
			"WAR-1": "",
		});
	});

	test("skips a row Jira returned without a key rather than keying on undefined", async () => {
		const { fetchImpl } = recordingFetch(() =>
			json({ issues: [{ fields: { status: { name: "To Do" } } }], isLast: true }),
		);
		expect(await new JiraClient(loadConfig(BASE), fetchImpl).issueStatuses()).toEqual({});
	});
});

describe("JiraClient failures", () => {
	test("carries the upstream status onto the error", async () => {
		const { fetchImpl } = recordingFetch(() => json({ errorMessages: ["nope"] }, 403));
		const client = new JiraClient(loadConfig(BASE), fetchImpl);
		await expect(client.getIssue("WAR-1")).rejects.toMatchObject({
			name: "JiraApiError",
			status: 403,
		});
	});

	test("keeps Retry-After off a rate-limited response", async () => {
		const { fetchImpl } = recordingFetch(
			() => new Response("{}", { status: 429, headers: { "retry-after": "12" } }),
		);
		const client = new JiraClient(loadConfig(BASE), fetchImpl);
		const err = await client.getIssue("WAR-1").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JiraApiError);
		expect((err as JiraApiError).retryAfter).toBe("12");
	});

	test("reads an unreachable Jira as status 0, which is not an HTTP answer", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("Unable to connect");
		}) as unknown as typeof fetch;
		const err = await new JiraClient(loadConfig(BASE), fetchImpl)
			.getIssue("WAR-1")
			.catch((e: unknown) => e);
		expect((err as JiraApiError).status).toBe(0);
		expect((err as JiraApiError).message).toMatch(/jira unreachable/);
	});

	test("treats a 204 as no body rather than failing to parse one", async () => {
		const { fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
		await expect(
			new JiraClient(loadConfig(BASE), fetchImpl).applyTransition("WAR-1", "31"),
		).resolves.toBeUndefined();
	});

	test("reads an empty 200 body as an upstream problem, not as an issue", async () => {
		// A proxy in front of Jira can answer 200 with nothing. Letting that
		// reach the mapping as undefined would surface as an internal error.
		const { fetchImpl } = recordingFetch(() => new Response("   ", { status: 200 }));
		const err = await new JiraClient(loadConfig(BASE), fetchImpl)
			.getIssue("WAR-1")
			.catch((e: unknown) => e);
		expect((err as JiraApiError).status).toBe(502);
		expect((err as JiraApiError).message).toMatch(/no object/);
	});

	test("says so when a 200 body is not JSON at all", async () => {
		const { fetchImpl } = recordingFetch(
			() => new Response("<html>proxy error</html>", { status: 200 }),
		);
		const err = await new JiraClient(loadConfig(BASE), fetchImpl)
			.getIssue("WAR-1")
			.catch((e: unknown) => e);
		expect((err as JiraApiError).status).toBe(502);
		expect((err as JiraApiError).message).toMatch(/not JSON/);
	});
});

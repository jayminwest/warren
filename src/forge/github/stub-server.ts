/**
 * Stateful in-memory GitHub REST stub — the fetch double the contract
 * conformance suite (`src/forge/contract.test.ts`) runs `GitHubForge`
 * against. Unlike `recordingFetch` (canned responses, one per call), this
 * stub routes on the URL and keeps PR state across calls, so the suite's
 * open → find → get → edit flow behaves like a real forge.
 *
 * Covers exactly the routes the provider calls: pulls create/list/get/patch,
 * check-runs, job logs, and branch-ref deletes. One handler per route keeps
 * each under the cognitive-complexity budget.
 */

import { jsonResponse } from "./test-helpers.ts";

interface StubPr {
	number: number;
	title: string;
	body: string;
	head: string;
	base: string;
	state: "open" | "closed";
	merged_at: string | null;
	headSha: string;
}

interface StubState {
	prs: StubPr[];
	nextNumber: number;
}

function prJson(pr: StubPr, origin: string) {
	return {
		number: pr.number,
		html_url: `${origin.replace("api.github.com", "github.com").replace("/repos", "")}/pull/${pr.number}`,
		state: pr.state,
		merged_at: pr.merged_at,
		head: { ref: pr.head, sha: pr.headSha },
		base: { ref: pr.base },
	};
}

function createPr(state: StubState, origin: string, bodyText: string | null): Response {
	const body = JSON.parse(bodyText ?? "{}") as {
		title?: string;
		body?: string;
		head?: string;
		base?: string;
	};
	const duplicate = state.prs.find(
		(p) => p.state === "open" && p.base === body.base && p.head === body.head,
	);
	if (duplicate !== undefined) {
		return jsonResponse(422, {
			message: `Validation Failed: A pull request already exists for ${duplicate.head}.`,
		});
	}
	const pr: StubPr = {
		number: state.nextNumber++,
		title: body.title ?? "",
		body: body.body ?? "",
		head: body.head ?? "",
		base: body.base ?? "",
		state: "open",
		merged_at: null,
		headSha: `stub-sha-${state.nextNumber}`,
	};
	state.prs.push(pr);
	return jsonResponse(201, prJson(pr, origin));
}

function listPrs(state: StubState, url: URL, owner: string): Response {
	const state$ = url.searchParams.get("state") ?? "open";
	const base = url.searchParams.get("base");
	const headFilter = url.searchParams.get("head");
	const hits = state.prs.filter((p) => {
		if (state$ !== "all" && p.state !== state$) return false;
		if (base !== null && p.base !== base) return false;
		// The owner-qualified filter only sees same-repo heads (§6.13).
		if (headFilter !== null && headFilter !== `${owner}:${p.head}`) return false;
		return true;
	});
	return jsonResponse(
		200,
		hits.map((p) => prJson(p, url.origin)),
	);
}

function getOrPatchPr(
	state: StubState,
	origin: string,
	numRaw: string,
	method: string,
	bodyText: string | null,
): Response {
	const pr = state.prs.find((p) => p.number === Number(numRaw));
	if (pr === undefined) return jsonResponse(404, { message: "Not Found" });
	if (method === "GET") return jsonResponse(200, prJson(pr, origin));
	if (method === "PATCH") {
		const body = JSON.parse(bodyText ?? "{}") as { body?: string };
		if (typeof body.body === "string") pr.body = body.body;
		return jsonResponse(200, prJson(pr, origin));
	}
	return jsonResponse(405, { message: "stub: method" });
}

function jobLogs(jobId: string): Response {
	const lines: string[] = [];
	for (let i = 1; i <= 20; i++) {
		lines.push(`[stub-github] job ${jobId} log line ${i}`);
	}
	return new Response(`${lines.join("\n")}\n`, { status: 200 });
}

/** Route one request. `tail` is the path after `/repos/:owner/:repo`. */
function route(
	state: StubState,
	method: string,
	owner: string,
	tail: string[],
	url: URL,
	bodyText: string | null,
): Response {
	if (tail[0] === "pulls" && tail.length === 1) {
		if (method === "POST") return createPr(state, url.origin, bodyText);
		if (method === "GET") return listPrs(state, url, owner);
	}
	if (tail[0] === "pulls" && tail.length === 2) {
		return getOrPatchPr(state, url.origin, tail[1] as string, method, bodyText);
	}
	if (tail[0] === "commits" && tail[2] === "check-runs" && method === "GET") {
		return jsonResponse(200, { check_runs: [] });
	}
	if (tail[0] === "actions" && tail[1] === "jobs" && tail[3] === "logs" && method === "GET") {
		return jobLogs(tail[2] as string);
	}
	if (tail[0] === "git" && tail[1] === "refs" && tail[2] === "heads" && method === "DELETE") {
		return new Response(null, { status: 204 });
	}
	return jsonResponse(404, { message: `stub: unrouted ${method} ${url.pathname}` });
}

export function stubGitHubServer(): { fetch: typeof fetch } {
	const state: StubState = { prs: [], nextNumber: 1 };
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw);
		const method = (init?.method ?? "GET").toUpperCase();
		const parts = url.pathname.split("/").filter((p) => p !== "");
		if (parts[0] !== "repos" || parts.length < 3) {
			return jsonResponse(404, { message: `stub: unrouted ${method} ${url.pathname}` });
		}
		const owner = decodeURIComponent(parts[1] as string);
		const bodyText = typeof init?.body === "string" ? init.body : null;
		return route(state, method, owner, parts.slice(3), url, bodyText);
	}) as unknown as typeof fetch;
	return { fetch: fn };
}

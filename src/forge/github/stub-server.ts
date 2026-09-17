/**
 * Stateful in-memory GitHub REST stub — the fetch double the contract
 * conformance suite (`src/forge/contract.test.ts`) runs `GitHubForge`
 * against. Unlike `recordingFetch` (canned responses, one per call), this
 * stub routes on the URL and keeps PR state across calls, so the suite's
 * open → find → get → edit flow behaves like a real forge.
 *
 * Covers exactly the routes the provider calls: pulls create/list/get/patch,
 * check-runs, job logs, branch-ref deletes, and — since pl-92a3 step 3 —
 * `POST /graphql` for the enable-auto-merge mutation. The returned handle
 * also scripts the GraphQL responses and patches the PR fields the arm
 * reads, so the auto-merge tests never touch the network or a clock. One
 * handler per route keeps each under the cognitive-complexity budget.
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
	draft: boolean;
	/** GraphQL node id the arm resolves from the REST read (`PR_<number>`). */
	nodeId: string;
	/** mergeable_state values served in order across reads; the last sticks. */
	mergeableStates: readonly string[];
	mergeableReads: number;
	/** REST `auto_merge` request object; non-null means armed. */
	autoMerge: { enabled: boolean } | null;
}

interface StubState {
	prs: StubPr[];
	nextNumber: number;
	graphqlScripts: StubGraphQLScript[];
}

/** One scripted `POST /graphql` response, drained in queue order. */
export interface StubGraphQLScript {
	/** Success data; defaults to a successful enablePullRequestAutoMerge payload. */
	readonly data?: unknown;
	/** GraphQL errors served with HTTP 200 — a non-empty array is the failure arm. */
	readonly errors?: ReadonlyArray<{ message: string; type?: string }>;
	/** Non-2xx HTTP status; serves `body` as `{"message": ...}` (default `"stub"`). */
	readonly status?: number;
	readonly body?: string;
}

/** Patch one stub pull request's arm-relevant state. */
export interface StubPrPatch {
	readonly state?: "open" | "closed";
	/** Sets the merged shape: closed plus a merged_at timestamp. */
	readonly merged?: boolean;
	readonly draft?: boolean;
	/** mergeable_state values served in order across reads; the last sticks. */
	readonly mergeableStates?: readonly string[];
	/** REST auto_merge object; non-null makes the next arm answer already_armed. */
	readonly autoMerge?: { enabled: boolean } | null;
}

/** The stub handle: the fetch double plus the scripting surface the tests use. */
export interface StubGitHubServer {
	readonly fetch: typeof fetch;
	/** Queue one scripted POST /graphql response; an empty queue arms the PR. */
	readonly scriptGraphQL: (script: StubGraphQLScript) => void;
	/** Patch one pull request's arm-relevant stub state. */
	readonly patchPullRequest: (prNumber: number, patch: StubPrPatch) => void;
}

function prJson(pr: StubPr, origin: string) {
	return {
		number: pr.number,
		html_url: `${origin.replace("api.github.com", "github.com").replace("/repos", "")}/pull/${pr.number}`,
		state: pr.state,
		merged_at: pr.merged_at,
		draft: pr.draft,
		node_id: pr.nodeId,
		mergeable_state: currentMergeableState(pr),
		auto_merge: pr.autoMerge,
		head: { ref: pr.head, sha: pr.headSha },
		base: { ref: pr.base },
	};
}

/** The state this read reports; GitHub computes mergeability asynchronously. */
function currentMergeableState(pr: StubPr): string {
	const index = Math.min(pr.mergeableReads, pr.mergeableStates.length - 1);
	return pr.mergeableStates[index] ?? "clean";
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
	const number = state.nextNumber;
	state.nextNumber += 1;
	const pr: StubPr = {
		number,
		title: body.title ?? "",
		body: body.body ?? "",
		head: body.head ?? "",
		base: body.base ?? "",
		state: "open",
		merged_at: null,
		headSha: `stub-sha-${number}`,
		draft: false,
		nodeId: `PR_${number}`,
		mergeableStates: ["clean"],
		mergeableReads: 0,
		autoMerge: null,
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
	if (method === "GET") {
		const json = prJson(pr, origin);
		pr.mergeableReads += 1;
		return jsonResponse(200, json);
	}
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

/** Serve one POST /graphql from the script queue; the default arms the PR it names. */
function graphqlRoute(state: StubState, bodyText: string | null): Response {
	const script = state.graphqlScripts.shift();
	if (script?.status !== undefined && script.status >= 300) {
		return jsonResponse(script.status, { message: script.body ?? "stub" });
	}
	if (script?.errors !== undefined && script.errors.length > 0) {
		return jsonResponse(200, { data: null, errors: script.errors });
	}
	markArmed(state, bodyText);
	return jsonResponse(200, {
		data: script?.data ?? { enablePullRequestAutoMerge: { clientMutationId: null } },
	});
}

/** A successful mutation arms the PR it names (`PR_<n>`), so the next read reports it. */
function markArmed(state: StubState, bodyText: string | null): void {
	const body = JSON.parse(bodyText ?? "{}") as {
		variables?: { input?: { pullRequestId?: unknown } } | null;
	} | null;
	const id = body?.variables?.input?.pullRequestId;
	if (typeof id !== "string") return;
	const match = /^PR_(\d+)$/.exec(id);
	if (match === null) return;
	const pr = state.prs.find((p) => p.number === Number(match?.[1]));
	if (pr !== undefined) pr.autoMerge = { enabled: true };
}

/** Patch one stub PR's arm-relevant state (the REST branch inputs). */
function patchPullRequest(state: StubState, prNumber: number, patch: StubPrPatch): void {
	const pr = state.prs.find((p) => p.number === prNumber);
	if (pr === undefined) return;
	if (patch.state !== undefined) pr.state = patch.state;
	if (patch.merged === true) {
		pr.state = "closed";
		pr.merged_at = "2026-09-17T00:00:00Z";
	}
	if (patch.merged === false) pr.merged_at = null;
	if (patch.draft !== undefined) pr.draft = patch.draft;
	if (patch.mergeableStates !== undefined) pr.mergeableStates = [...patch.mergeableStates];
	if (patch.autoMerge !== undefined) pr.autoMerge = patch.autoMerge;
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

/** Resolve a fetch stub call into its URL, uppercased method, and string body. */
function requestRoute(
	input: URL | RequestInfo,
	init?: RequestInit,
): { url: URL; method: string; bodyText: string | null } {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return {
		url: new URL(raw),
		method: (init?.method ?? "GET").toUpperCase(),
		bodyText: typeof init?.body === "string" ? init.body : null,
	};
}

export function stubGitHubServer(): StubGitHubServer {
	const state: StubState = { prs: [], nextNumber: 1, graphqlScripts: [] };
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const { url, method, bodyText } = requestRoute(input, init);
		if (url.pathname === "/graphql") {
			if (method !== "POST") return jsonResponse(405, { message: "stub: method" });
			return graphqlRoute(state, bodyText);
		}
		const parts = url.pathname.split("/").filter((p) => p !== "");
		if (parts[0] !== "repos" || parts.length < 3) {
			return jsonResponse(404, { message: `stub: unrouted ${method} ${url.pathname}` });
		}
		const owner = decodeURIComponent(parts[1] as string);
		return route(state, method, owner, parts.slice(3), url, bodyText);
	}) as unknown as typeof fetch;
	return {
		fetch: fn,
		scriptGraphQL: (script) => state.graphqlScripts.push(script),
		patchPullRequest: (prNumber, patch) => patchPullRequest(state, prNumber, patch),
	};
}

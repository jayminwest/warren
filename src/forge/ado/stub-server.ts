/**
 * Stateful in-memory Azure DevOps REST stub — the fetch double the
 * contract conformance suite (`src/forge/contract.test.ts`) runs
 * `AdoForge` against. It routes on the URL and keeps pull-request state
 * across calls, so the suite's open → find → get → edit flow behaves like
 * a real forge.
 *
 * Covers exactly the routes the provider calls: pull requests
 * create/list/get/patch, refs list/update, builds list, build timeline,
 * and build logs. A duplicate create answers a real 409 so the
 * idempotency contract is exercised.
 */

import { jsonResponse } from "../github/test-helpers.ts";

interface StubPr {
	pullRequestId: number;
	title: string;
	description: string;
	sourceRefName: string;
	targetRefName: string;
	status: "active" | "completed" | "abandoned";
	closedDate: string | null;
	headSha: string;
}

interface StubBuild {
	id: number;
	sourceVersion: string;
	sourceBranch?: string;
	status: string;
	result: string | null;
	definitionName: string;
	/** ISO timestamp; when set, the listing orders newest first like the service. */
	queueTime?: string;
}

/** The GUID the repository-metadata route answers with. */
export const REPO_GUID = "11111111-2222-3333-4444-555555555555";

export interface AdoStubState {
	prs: StubPr[];
	nextNumber: number;
	/** Branch → object id; the refs routes read and delete from it. */
	refs: Map<string, string>;
	builds: StubBuild[];
	/** Every request, for assertions on auth and paths. */
	calls: { method: string; url: string; authorization: string | null }[];
}

function prJson(pr: StubPr) {
	return {
		pullRequestId: pr.pullRequestId,
		status: pr.status,
		closedDate: pr.closedDate,
		sourceRefName: pr.sourceRefName,
		targetRefName: pr.targetRefName,
		lastMergeSourceCommit: { commitId: pr.headSha },
	};
}

function createPr(state: AdoStubState, bodyText: string | null): Response {
	const body = JSON.parse(bodyText ?? "{}") as {
		title?: string;
		description?: string;
		sourceRefName?: string;
		targetRefName?: string;
	};
	const duplicate = state.prs.find(
		(p) =>
			p.status === "active" &&
			p.sourceRefName === body.sourceRefName &&
			p.targetRefName === body.targetRefName,
	);
	if (duplicate !== undefined) {
		return jsonResponse(409, {
			message: `TF401179: An active pull request for the source and target branch already exists.`,
		});
	}
	const pr: StubPr = {
		pullRequestId: state.nextNumber++,
		title: body.title ?? "",
		description: body.description ?? "",
		sourceRefName: body.sourceRefName ?? "",
		targetRefName: body.targetRefName ?? "",
		status: "active",
		closedDate: null,
		headSha: `stub-sha-${state.nextNumber}`,
	};
	state.prs.push(pr);
	return jsonResponse(201, prJson(pr));
}

function listPrs(state: AdoStubState, url: URL): Response {
	const status = url.searchParams.get("searchCriteria.status") ?? "active";
	const source = url.searchParams.get("searchCriteria.sourceRefName");
	const target = url.searchParams.get("searchCriteria.targetRefName");
	const hits = state.prs.filter((p) => {
		if (status !== "all" && p.status !== status) return false;
		if (source !== null && p.sourceRefName !== source) return false;
		if (target !== null && p.targetRefName !== target) return false;
		return true;
	});
	return jsonResponse(200, { value: hits.map(prJson), count: hits.length });
}

function getOrPatchPr(
	state: AdoStubState,
	numRaw: string,
	method: string,
	bodyText: string | null,
): Response {
	const pr = state.prs.find((p) => p.pullRequestId === Number(numRaw));
	if (pr === undefined) {
		return jsonResponse(404, { message: `TF401180: The requested pull request was not found.` });
	}
	if (method === "GET") return jsonResponse(200, prJson(pr));
	if (method === "PATCH") {
		const body = JSON.parse(bodyText ?? "{}") as { description?: string };
		if (typeof body.description === "string") pr.description = body.description;
		return jsonResponse(200, prJson(pr));
	}
	return jsonResponse(405, { message: "stub: method" });
}

function listRefs(state: AdoStubState, url: URL): Response {
	const filter = url.searchParams.get("filter") ?? "";
	const value = [...state.refs.entries()]
		.filter(([branch]) => `heads/${branch}`.startsWith(filter))
		.map(([branch, objectId]) => ({ name: `refs/heads/${branch}`, objectId }));
	return jsonResponse(200, { value, count: value.length });
}

function updateRefs(state: AdoStubState, bodyText: string | null): Response {
	const updates = JSON.parse(bodyText ?? "[]") as {
		name?: string;
		oldObjectId?: string;
		newObjectId?: string;
	}[];
	const value = updates.map((u) => {
		const branch = (u.name ?? "").replace(/^refs\/heads\//, "");
		const current = state.refs.get(branch);
		if (current === undefined || current !== u.oldObjectId) {
			return { name: u.name, success: false, updateStatus: "staleOldObjectId" };
		}
		if (u.newObjectId === "0000000000000000000000000000000000000000") state.refs.delete(branch);
		else state.refs.set(branch, u.newObjectId ?? current);
		return { name: u.name, success: true, updateStatus: "succeeded" };
	});
	return jsonResponse(200, { value, count: value.length });
}

function listBuilds(state: AdoStubState, url: URL): Response {
	const branch = url.searchParams.get("branchName");
	const value = state.builds
		.filter((b) => branch === null || b.sourceBranch === branch)
		.sort((a, b) => Date.parse(b.queueTime ?? "") - Date.parse(a.queueTime ?? "") || 0)
		.map((b) => ({
			id: b.id,
			status: b.status,
			result: b.result,
			sourceVersion: b.sourceVersion,
			...(b.sourceBranch !== undefined ? { sourceBranch: b.sourceBranch } : {}),
			...(b.queueTime !== undefined ? { queueTime: b.queueTime } : {}),
			definition: { name: b.definitionName },
			repository: { name: "widget" },
			_links: { web: { href: `https://dev.azure.com/stub/_build/results?buildId=${b.id}` } },
		}));
	return jsonResponse(200, { value, count: value.length });
}

function buildLog(buildId: string): Response {
	const lines: string[] = [];
	for (let i = 1; i <= 20; i++) {
		lines.push(`[stub-ado] build ${buildId} log line ${i}`);
	}
	return new Response(`${lines.join("\n")}\n`, { status: 200 });
}

/** Route one `_apis/build/...` request. */
function routeBuild(state: AdoStubState, tail: string[], url: URL): Response {
	if (tail[0] === "builds" && tail.length === 1) return listBuilds(state, url);
	if (tail[0] === "builds" && tail[2] === "timeline") {
		return jsonResponse(200, {
			records: [
				{ type: "Job", result: "failed", log: { id: 1 } },
				{ type: "Task", result: "succeeded", log: { id: 2 } },
				{ type: "Task", result: "failed", log: { id: 3 } },
			],
		});
	}
	if (tail[0] === "builds" && tail[2] === "logs" && tail.length === 4) {
		return buildLog(tail[1] as string);
	}
	return jsonResponse(404, { message: `stub: unrouted build route ${tail.join("/")}` });
}

/** Route one `_apis/git/repositories/<repo>/...` request. */
function routeGit(
	state: AdoStubState,
	method: string,
	tail: string[],
	url: URL,
	bodyText: string | null,
): Response {
	if (tail[0] === "pullrequests" && tail.length === 1) {
		if (method === "POST") return createPr(state, bodyText);
		if (method === "GET") return listPrs(state, url);
	}
	if (tail[0] === "pullrequests" && tail.length === 2) {
		return getOrPatchPr(state, tail[1] as string, method, bodyText);
	}
	if (tail[0] === "refs" && tail.length === 1) {
		if (method === "GET") return listRefs(state, url);
		if (method === "POST") return updateRefs(state, bodyText);
	}
	return jsonResponse(404, { message: `stub: unrouted ${method} ${url.pathname}` });
}

export function stubAdoServer(seed: Partial<AdoStubState> = {}): {
	fetch: typeof fetch;
	state: AdoStubState;
} {
	const state: AdoStubState = {
		prs: [],
		nextNumber: 1,
		refs: new Map([["warren/run-1", "abc123"]]),
		builds: [],
		calls: [],
		...seed,
	};
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const headers = (init?.headers ?? {}) as Record<string, string>;
		state.calls.push({ method, url: raw, authorization: headers.authorization ?? null });
		const bodyText = typeof init?.body === "string" ? init.body : null;
		return route(state, method, new URL(raw), bodyText);
	}) as unknown as typeof fetch;
	return { fetch: fn, state };
}

/** Route one request by area: `/<org>/<project>/_apis/<area>/...`. */
function route(state: AdoStubState, method: string, url: URL, bodyText: string | null): Response {
	const parts = url.pathname.split("/").filter((p) => p !== "");
	if (url.hostname !== "dev.azure.com" || parts[2] !== "_apis") {
		return jsonResponse(404, { message: `stub: unrouted ${method} ${url.pathname}` });
	}
	if (parts[3] === "build") return routeBuild(state, parts.slice(4), url);
	if (parts[3] === "git" && parts[4] === "repositories" && parts.length === 6) {
		return jsonResponse(200, { id: REPO_GUID, name: decodeURIComponent(parts[5] as string) });
	}
	if (parts[3] === "git" && parts[4] === "repositories" && parts.length > 6) {
		return routeGit(state, method, parts.slice(6), url, bodyText);
	}
	return jsonResponse(404, { message: `stub: unrouted ${method} ${url.pathname}` });
}

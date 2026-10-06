/**
 * Stateful in-memory GitLab REST stub — the fetch double the contract
 * conformance suite (`src/forge/contract.test.ts`) runs `GitLabForge`
 * against. It routes on the path after `/api/v4/`, whatever the instance
 * origin, and keeps merge-request state across calls, so the suite's
 * open → find → get → edit flow behaves like a real forge.
 *
 * Covers exactly the routes the provider calls: merge requests
 * create/list/get/update, branches get/delete, pipelines by sha, a
 * pipeline's jobs, a job's trace, and the token's user. A duplicate create
 * answers a real 409 so the idempotency contract is exercised.
 */

import { jsonResponse } from "../github/test-helpers.ts";

interface StubMergeRequest {
	iid: number;
	title: string;
	description: string;
	source_branch: string;
	target_branch: string;
	state: "opened" | "closed" | "merged";
	merged_at: string | null;
	sha: string;
	merge_when_pipeline_succeeds: boolean;
}

interface StubJob {
	id: number;
	name: string;
	status: string;
	allow_failure?: boolean;
}

interface StubPipeline {
	id: number;
	sha: string;
	jobs: StubJob[];
}

export interface GitLabStubState {
	mergeRequests: StubMergeRequest[];
	nextIid: number;
	/** Branch → tip commit; the branch routes read and delete from it. */
	branches: Map<string, string>;
	pipelines: StubPipeline[];
	/** What `GET /user` answers; `null` → 401. */
	user: Record<string, unknown> | null;
	/** Every request, for assertions on auth and paths. */
	calls: { method: string; url: string; privateToken: string | null }[];
}

function notFound(what: string): Response {
	return jsonResponse(404, { message: `404 ${what} Not Found` });
}

function createMergeRequest(state: GitLabStubState, bodyText: string | null): Response {
	const body = JSON.parse(bodyText ?? "{}") as Partial<StubMergeRequest> & {
		title?: string;
		description?: string;
	};
	const duplicate = state.mergeRequests.find(
		(mr) =>
			mr.state === "opened" &&
			mr.source_branch === body.source_branch &&
			mr.target_branch === body.target_branch,
	);
	if (duplicate !== undefined) {
		return jsonResponse(409, {
			message: [
				`Another open merge request already exists for this source branch: !${duplicate.iid}`,
			],
		});
	}
	const mr: StubMergeRequest = {
		iid: state.nextIid++,
		title: body.title ?? "",
		description: body.description ?? "",
		source_branch: body.source_branch ?? "",
		target_branch: body.target_branch ?? "",
		state: "opened",
		merged_at: null,
		sha: `stub-sha-${state.nextIid}`,
		merge_when_pipeline_succeeds: false,
	};
	state.mergeRequests.push(mr);
	return jsonResponse(201, mr);
}

function listMergeRequests(state: GitLabStubState, url: URL): Response {
	const wanted = url.searchParams.get("state") ?? "all";
	const source = url.searchParams.get("source_branch");
	const target = url.searchParams.get("target_branch");
	const hits = state.mergeRequests.filter(
		(mr) =>
			(wanted === "all" || mr.state === wanted) &&
			(source === null || mr.source_branch === source) &&
			(target === null || mr.target_branch === target),
	);
	return jsonResponse(200, [...hits].reverse());
}

function mergeRequest(
	state: GitLabStubState,
	iidRaw: string,
	method: string,
	bodyText: string | null,
): Response {
	const mr = state.mergeRequests.find((m) => m.iid === Number(iidRaw));
	if (mr === undefined) return notFound("Merge Request");
	if (method === "PUT") {
		const body = JSON.parse(bodyText ?? "{}") as { description?: string };
		if (typeof body.description === "string") mr.description = body.description;
	}
	return jsonResponse(200, mr);
}

function branch(state: GitLabStubState, name: string, method: string): Response {
	const tip = state.branches.get(name);
	if (tip === undefined) return notFound("Branch");
	if (method === "DELETE") {
		state.branches.delete(name);
		return new Response(null, { status: 204 });
	}
	return jsonResponse(200, { name, commit: { id: tip } });
}

function pipelines(state: GitLabStubState, url: URL): Response {
	const sha = url.searchParams.get("sha");
	const hits = state.pipelines
		.filter((p) => sha === null || p.sha === sha)
		.sort((a, b) => b.id - a.id)
		.map((p) => ({ id: p.id, sha: p.sha, status: "running" }));
	return jsonResponse(200, hits.slice(0, Number(url.searchParams.get("per_page") ?? "20")));
}

function pipelineJobs(state: GitLabStubState, idRaw: string): Response {
	const pipeline = state.pipelines.find((p) => p.id === Number(idRaw));
	if (pipeline === undefined) return notFound("Pipeline");
	return jsonResponse(
		200,
		pipeline.jobs.map((job) => ({
			...job,
			allow_failure: job.allow_failure ?? false,
			web_url: `https://gitlab.example/stub/-/jobs/${job.id}`,
		})),
	);
}

function trace(jobId: string): Response {
	const lines: string[] = [];
	for (let i = 1; i <= 20; i++) {
		lines.push(`[stub-gitlab] job ${jobId} trace line ${i}`);
	}
	return new Response(`${lines.join("\n")}\n`, {
		status: 200,
		headers: { "content-type": "text/plain" },
	});
}

/** Route `/projects/<id>/<tail...>`. */
function routeProject(
	state: GitLabStubState,
	method: string,
	tail: string[],
	url: URL,
	bodyText: string | null,
): Response {
	const [resource, id, sub] = tail;
	if (resource === "merge_requests" && tail.length === 1) {
		return method === "POST" ? createMergeRequest(state, bodyText) : listMergeRequests(state, url);
	}
	if (resource === "merge_requests" && tail.length === 2) {
		return mergeRequest(state, id as string, method, bodyText);
	}
	if (resource === "repository" && id === "branches" && sub !== undefined) {
		return branch(state, decodeURIComponent(tail.slice(2).join("/")), method);
	}
	if (resource === "pipelines" && tail.length === 1) return pipelines(state, url);
	if (resource === "pipelines" && sub === "jobs") return pipelineJobs(state, id as string);
	if (resource === "jobs" && sub === "trace") return trace(id as string);
	return jsonResponse(404, { message: `stub: unrouted ${method} ${url.pathname}` });
}

export function stubGitLabServer(seed: Partial<GitLabStubState> = {}): {
	fetch: typeof fetch;
	state: GitLabStubState;
} {
	const state: GitLabStubState = {
		mergeRequests: [],
		nextIid: 1,
		branches: new Map([["warren/run-1", "abc123"]]),
		pipelines: [],
		user: { username: "project_7_bot_abc", name: "warren", commit_email: "bot@noreply.stub" },
		calls: [],
		...seed,
	};
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const headers = (init?.headers ?? {}) as Record<string, string>;
		state.calls.push({ method, url: raw, privateToken: headers["private-token"] ?? null });
		const bodyText = typeof init?.body === "string" ? init.body : null;
		return route(state, method, new URL(raw), bodyText);
	}) as unknown as typeof fetch;
	return { fetch: fn, state };
}

/** Route one request on the path after `/api/v4/`. */
function route(
	state: GitLabStubState,
	method: string,
	url: URL,
	bodyText: string | null,
): Response {
	const marker = url.pathname.indexOf("/api/v4/");
	if (marker === -1) return jsonResponse(404, { message: `stub: not an API path ${url.pathname}` });
	// Split before decoding: the project id is one segment with its
	// slashes encoded as %2F.
	const parts = url.pathname.slice(marker + "/api/v4/".length).split("/");
	if (parts[0] === "user" && parts.length === 1) {
		return state.user === null
			? jsonResponse(401, { message: "401 Unauthorized" })
			: jsonResponse(200, state.user);
	}
	if (parts[0] === "projects" && parts.length > 2) {
		return routeProject(state, method, parts.slice(2), url, bodyText);
	}
	return jsonResponse(404, { message: `stub: unrouted ${method} ${url.pathname}` });
}

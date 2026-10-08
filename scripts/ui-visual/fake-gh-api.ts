/**
 * In-memory GitHub REST fake for the ui-visual comment tests (warren-70d9)
 * and the design-review workflow tests (warren-a694). Covers only the
 * endpoints those scripts call. Test support, not shipped.
 */

import { type GhApi, GhApiError, type HttpMethod } from "./gh-api.ts";

export interface FakeComment {
	id: number;
	body: string;
	user: { type: string };
}

interface FakeCommit {
	message: string;
	tree: string;
	parents: string[];
}

export interface FakeCheckRun {
	id: number;
	name: string;
	head_sha: string;
	status: string;
	conclusion?: string;
	output?: { title: string; summary: string };
	details_url?: string;
}

type Handler = (method: HttpMethod, match: RegExpExecArray, body: unknown) => unknown;

export class FakeGhApi implements GhApi {
	readonly calls: string[] = [];
	readonly comments = new Map<number, FakeComment[]>();
	readonly runs = new Map<string, unknown>();
	readonly pulls = new Map<number, unknown>();
	readonly refs = new Map<string, string>();
	readonly commits = new Map<string, FakeCommit>();
	readonly trees = new Map<string, { path: string; sha: string }[]>();
	readonly blobs = new Map<string, string>();
	/** PR number -> its `pulls/:n/files` entries. */
	readonly pullFiles = new Map<number, unknown[]>();
	readonly checkRuns: FakeCheckRun[] = [];
	/** Called before a ref update; lets a test move the branch underneath. */
	beforeRefUpdate: (() => void) | null = null;
	private next = 1;

	private readonly routes: [RegExp, Handler][] = [
		[
			/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files/,
			(_m, x) => this.pullFiles.get(Number(x[1])) ?? [],
		],
		[/^repos\/[^/]+\/[^/]+\/commits\/(\w+)\/check-runs/, (_m, x) => this.listChecks(x[1] ?? "")],
		[/^repos\/[^/]+\/[^/]+\/check-runs$/, (_m, _x, b) => this.createCheck(b)],
		[/^repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/, (_m, x, b) => this.editCheck(Number(x[1]), b)],
		[
			/^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/,
			(_m, x) => this.found(this.runs.get(x[1] ?? "")),
		],
		[/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/, (_m, x) => this.found(this.pulls.get(Number(x[1])))],
		[
			/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/,
			(m, x, b) => this.issueComments(m, Number(x[1]), b),
		],
		[
			/^repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/,
			(_m, x, b) => this.editComment(Number(x[1]), b),
		],
		[/^repos\/[^/]+\/[^/]+\/git\/blobs$/, (_m, _x, b) => this.createBlob(b)],
		[/^repos\/[^/]+\/[^/]+\/git\/trees$/, (_m, _x, b) => this.createTree(b)],
		[/^repos\/[^/]+\/[^/]+\/git\/trees\/(\w+)/, (_m, x) => this.readTree(x[1] ?? "")],
		[/^repos\/[^/]+\/[^/]+\/git\/commits$/, (_m, _x, b) => this.createCommit(b)],
		[/^repos\/[^/]+\/[^/]+\/git\/commits\/(\w+)$/, (_m, x) => this.readCommit(x[1] ?? "")],
		[/^repos\/[^/]+\/[^/]+\/git\/refs$/, (_m, _x, b) => this.createRef(b)],
		[/^repos\/[^/]+\/[^/]+\/git\/refs?\/heads\/(.+)$/, (m, x, b) => this.ref(m, x[1] ?? "", b)],
	];

	request(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
		this.calls.push(`${method} ${path}`);
		for (const [pattern, handler] of this.routes) {
			const match = pattern.exec(path);
			if (match !== null) return Promise.resolve().then(() => handler(method, match, body));
		}
		return Promise.reject(new GhApiError(`no fake route for ${method} ${path}`, 404));
	}

	paginate(path: string): Promise<unknown[]> {
		return this.request("GET", path) as Promise<unknown[]>;
	}

	addComment(pr: number, body: string, type = "Bot"): FakeComment {
		const comment = { id: this.next++, body, user: { type } };
		this.comments.set(pr, [...(this.comments.get(pr) ?? []), comment]);
		return comment;
	}

	/** Files on a branch head, path -> blob content. */
	files(branch: string): Map<string, string> {
		const commit = this.commits.get(this.refs.get(branch) ?? "");
		const entries = this.trees.get(commit?.tree ?? "") ?? [];
		return new Map(entries.map((e) => [e.path, this.blobs.get(e.sha) ?? ""]));
	}

	/** The check runs on a commit, newest first, as `filter=latest` lists them. */
	private listChecks(sha: string): unknown {
		const runs = this.checkRuns.filter((r) => r.head_sha === sha).reverse();
		return { total_count: runs.length, check_runs: runs };
	}

	private createCheck(body: unknown): unknown {
		const run = { id: this.next++, ...(body as Omit<FakeCheckRun, "id">) };
		this.checkRuns.push(run);
		return run;
	}

	private editCheck(id: number, body: unknown): unknown {
		const run = this.found(this.checkRuns.find((r) => r.id === id)) as FakeCheckRun;
		Object.assign(run, body);
		return run;
	}

	private found(value: unknown): unknown {
		if (value === undefined) throw new GhApiError("Not Found (HTTP 404)", 404);
		return value;
	}

	private sha(): string {
		return (this.next++).toString(16).padStart(40, "0");
	}

	private issueComments(method: HttpMethod, pr: number, body: unknown): unknown {
		if (method === "GET") return this.comments.get(pr) ?? [];
		return this.addComment(pr, (body as { body: string }).body);
	}

	private editComment(id: number, body: unknown): unknown {
		for (const list of this.comments.values()) {
			const comment = list.find((c) => c.id === id);
			if (comment !== undefined) {
				comment.body = (body as { body: string }).body;
				return comment;
			}
		}
		throw new GhApiError("Not Found (HTTP 404)", 404);
	}

	private createBlob(body: unknown): unknown {
		const sha = this.sha();
		this.blobs.set(sha, (body as { content: string }).content);
		return { sha };
	}

	private createTree(body: unknown): unknown {
		const sha = this.sha();
		this.trees.set(sha, (body as { tree: { path: string; sha: string }[] }).tree);
		return { sha };
	}

	private readTree(sha: string): unknown {
		const entries = this.found(this.trees.get(sha)) as { path: string; sha: string }[];
		return { tree: entries.map((e) => ({ ...e, type: "blob" })) };
	}

	private createCommit(body: unknown): unknown {
		const sha = this.sha();
		this.commits.set(sha, body as FakeCommit);
		return { sha };
	}

	private readCommit(sha: string): unknown {
		const commit = this.found(this.commits.get(sha)) as FakeCommit;
		return { message: commit.message, tree: { sha: commit.tree } };
	}

	private createRef(body: unknown): unknown {
		const { ref, sha } = body as { ref: string; sha: string };
		const branch = ref.replace("refs/heads/", "");
		if (this.refs.has(branch)) throw new GhApiError("Reference already exists (HTTP 422)", 422);
		this.refs.set(branch, sha);
		return { ref };
	}

	private ref(method: HttpMethod, branch: string, body: unknown): unknown {
		if (method === "GET") return { object: { sha: this.found(this.refs.get(branch)) } };
		this.beforeRefUpdate?.();
		const { sha, force } = body as { sha: string; force: boolean };
		const current = this.refs.get(branch);
		const parents = this.commits.get(sha)?.parents ?? [];
		if (!force && current !== undefined && !parents.includes(current)) {
			throw new GhApiError("Update is not a fast forward (HTTP 422)", 422);
		}
		this.refs.set(branch, sha);
		return { object: { sha } };
	}
}

/**
 * GitLabForge — the GitLab arm of the `Forge` contract (forge-contract.md
 * §1), behind `WARREN_FORGE=gitlab`. GH#1028.
 *
 * What this provider is:
 *   - `parseRepoRef` absorbs the clone-URL grammars of ONE GitLab instance,
 *     named by `WARREN_GITLAB_URL` (`./repo-ref.ts`). It NEVER throws and
 *     returns `null` for foreign hosts. Nested groups pack into
 *     `RepoRef.key`; the contract gains no field for them.
 *   - Pull requests are merge requests. `openPullRequest` is idempotent by
 *     contract: GitLab answers a duplicate with 409, which resolves to the
 *     existing merge request through `findPullRequest`. A fork-qualified
 *     head (`owner:branch`) is `unsupported` rather than mis-targeted,
 *     because a cross-project merge request needs the source project id.
 *   - `gitCredential` returns the configured token with `expiresAt: null`
 *     (§4 — static lifetime skips the re-mint path) and `oauth2` as the
 *     username, which GitLab accepts for personal, project and group
 *     access tokens.
 *   - `listChecks` reads the jobs of the newest pipeline for the commit,
 *     and `fetchJobLogTail` tails a job's trace (`./checks.ts`).
 *   - `botIdentity` reads `GET /user`: a project or group access token is
 *     a bot user of its own, and its commit email is the bot's noreply
 *     address.
 *
 * Capabilities (§5): `autoMergeArm` is false for this cut, but
 * `getPullRequest` reports `merge_when_pipeline_succeeds`, so the
 * plan-run stall warning reads armed or unarmed instead of unknown.
 *
 * Seam discipline (§2.2): every method returns `ForgeResult<T>` and never
 * throws. Boot-time failures live in `src/forge/registry.ts`.
 */

import type {
	ArmAutoMergeOptions,
	ArmAutoMergeResult,
	CheckRun,
	CheckSummary,
	Forge,
	ForgeCapabilities,
	ForgeRepoListing,
	ForgeResult,
	GitCredential,
	GitIdentity,
	PullRequestDraft,
	PullRequestQuery,
	PullRequestRef,
	PullRequestState,
	RepoRef,
} from "../contract.ts";
import { readJson, readText } from "../github/readers.ts";
import { isCommitSha, parseJob, rollUpJobs } from "./checks.ts";
import { err, type GitLabTransportResult, ok, requestGitLab, toForgeError } from "./http.ts";
import {
	GITLAB_FORGE_KIND,
	type GitLabInstance,
	gitLabRepoLayout,
	parseGitLabRepoRef,
	unpackGitLabRef,
} from "./repo-ref.ts";

export { GITLAB_FORGE_KIND } from "./repo-ref.ts";

/** Basic-auth username sent beside the token on git-over-HTTPS. */
const TOKEN_USERNAME = "oauth2";

/** The title prefix GitLab reads as a draft merge request. */
const DRAFT_PREFIX = "Draft: ";

export interface GitLabForgeOptions {
	/** The instance from `WARREN_GITLAB_URL`, parsed at boot. */
	readonly instance: GitLabInstance;
	/** The access token. Empty string → methods return `no_credential`. */
	readonly token: string;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Per-request deadline override. */
	readonly timeoutMs?: number;
}

interface MergeRequestJson {
	readonly iid?: unknown;
	readonly state?: unknown;
	readonly merged_at?: unknown;
	readonly sha?: unknown;
	readonly target_branch?: unknown;
	readonly merge_when_pipeline_succeeds?: unknown;
}

interface RequestInput {
	readonly path: string;
	readonly method?: "GET" | "POST" | "PUT" | "DELETE";
	readonly body?: unknown;
	readonly query?: Record<string, string>;
	readonly accept?: string;
	readonly context: string;
}

export class GitLabForge implements Forge {
	readonly capabilities: ForgeCapabilities;

	private readonly instance: GitLabInstance;
	private readonly token: string;
	private readonly fetch: typeof fetch;
	private readonly timeoutMs: number | undefined;

	constructor(options: GitLabForgeOptions) {
		this.instance = options.instance;
		this.token = options.token;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs;
		this.capabilities = {
			checkRuns: true,
			jobLogs: true,
			pullRequestBodyEdit: true,
			branchDelete: true,
			botIdentity: true,
			// A token has no installation scope (§5): no repo listing.
			installationRepos: false,
			// Merge-when-pipeline-succeeds arming is a follow-up: no arming yet.
			autoMergeArm: false,
			credentialLifetime: "static",
		};
	}

	parseRepoRef(cloneUrl: string): RepoRef | null {
		return parseGitLabRepoRef(this.instance, cloneUrl);
	}

	repoLayout(cloneUrl: string): { owner: string; name: string } | null {
		return gitLabRepoLayout(this.instance, cloneUrl);
	}

	gitCredential(ref: RepoRef): Promise<ForgeResult<GitCredential>> {
		const token = this.credential(ref);
		if (!token.ok) return Promise.resolve(err(token.error));
		return Promise.resolve(ok({ username: TOKEN_USERNAME, secret: token.value, expiresAt: null }));
	}

	async openPullRequest(ref: RepoRef, req: PullRequestDraft): Promise<ForgeResult<PullRequestRef>> {
		if (req.headBranch.includes(":")) {
			return err({
				kind: "unsupported",
				detail: `GitLabForge opens merge requests from the project's own branches only: ${req.headBranch}`,
			});
		}
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const result = await this.request(ref, {
			path: "merge_requests",
			method: "POST",
			context: "POST /merge_requests",
			body: {
				source_branch: req.headBranch,
				target_branch: req.baseBranch,
				title: req.draft === true ? `${DRAFT_PREFIX}${req.title}` : req.title,
				description: req.body,
			},
		});
		if (!result.ok) {
			// Idempotency (§1): "Another open merge request already exists" is a 409.
			if (result.error.status === 409) {
				const existing = await this.findPullRequest(ref, {
					headBranch: req.headBranch,
					baseBranch: req.baseBranch,
				});
				if (existing.ok && existing.value !== null) return ok(existing.value);
			}
			return err(toForgeError(result.error));
		}
		const created = (await readJson(result.response)) as MergeRequestJson | null;
		const iid = created === null ? null : mergeRequestIid(created);
		if (iid === null) {
			return err({ kind: "http_error", detail: "POST /merge_requests returned no iid" });
		}
		return ok(this.toRef(ref, iid));
	}

	async findPullRequest(
		ref: RepoRef,
		q: PullRequestQuery,
	): Promise<ForgeResult<PullRequestRef | null>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const state = q.state ?? "open";
		const result = await this.request(ref, {
			path: "merge_requests",
			context: "GET /merge_requests",
			query: {
				source_branch: q.headBranch,
				target_branch: q.baseBranch,
				state: state === "open" ? "opened" : "all",
				per_page: "100",
			},
		});
		if (!result.ok) return err(toForgeError(result.error));
		const body = await readJson(result.response);
		if (!Array.isArray(body)) {
			return err({ kind: "http_error", detail: "GET /merge_requests returned a non-list body" });
		}
		for (const item of body as MergeRequestJson[]) {
			// "closed" on the seam means not open: merged counts, as on GitHub.
			if (state === "closed" && item.state === "opened") continue;
			const iid = mergeRequestIid(item);
			if (iid !== null) return ok(this.toRef(ref, iid));
		}
		return ok(null);
	}

	async getPullRequest(ref: RepoRef, pr: PullRequestRef): Promise<ForgeResult<PullRequestState>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const result = await this.request(ref, {
			path: `merge_requests/${pr.number}`,
			context: `GET /merge_requests/${pr.number}`,
		});
		if (!result.ok) return err(toForgeError(result.error));
		const body = (await readJson(result.response)) as MergeRequestJson | null;
		if (body === null) {
			return err({
				kind: "http_error",
				detail: `GET /merge_requests/${pr.number} returned no body`,
			});
		}
		const lifecycle =
			body.state === "merged" ? "merged" : body.state === "closed" ? "closed_unmerged" : "open";
		const mergedRaw = typeof body.merged_at === "string" ? Date.parse(body.merged_at) : Number.NaN;
		const armed = body.merge_when_pipeline_succeeds;
		return ok({
			lifecycle,
			mergedAt: lifecycle === "merged" && Number.isFinite(mergedRaw) ? mergedRaw : null,
			headCommit: typeof body.sha === "string" ? body.sha : "",
			baseBranch: typeof body.target_branch === "string" ? body.target_branch : "",
			autoMerge: armed === true ? "armed" : armed === false ? "unarmed" : "unknown",
		});
	}

	/** Arming merge-when-pipeline-succeeds is a follow-up: unsupported, honestly. */
	armAutoMerge(
		_ref: RepoRef,
		_pr: PullRequestRef,
		_options: ArmAutoMergeOptions,
	): Promise<ArmAutoMergeResult> {
		return Promise.resolve({
			ok: false,
			error: {
				reason: "unsupported_forge",
				message: "GitLabForge does not arm merge-when-pipeline-succeeds yet",
			},
		});
	}

	async setPullRequestBody(
		ref: RepoRef,
		pr: PullRequestRef,
		body: string,
	): Promise<ForgeResult<void>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const result = await this.request(ref, {
			path: `merge_requests/${pr.number}`,
			method: "PUT",
			context: `PUT /merge_requests/${pr.number}`,
			body: { description: body },
		});
		if (!result.ok) return err(toForgeError(result.error));
		return ok(undefined);
	}

	/**
	 * Read CI state for `commit`, a SHA or a branch name: the contract
	 * passes a commit, but the ci-fixer polls by run branch. A branch
	 * resolves to its tip first, so a merge-request pipeline (which runs on
	 * `refs/merge-requests/<iid>/head`, not on the branch) still counts. A
	 * branch that does not exist has no checks yet.
	 */
	async listChecks(ref: RepoRef, commit: string): Promise<ForgeResult<CheckSummary>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const sha = isCommitSha(commit) ? ok(commit) : await this.branchTip(ref, commit);
		if (!sha.ok) return sha.error.kind === "not_found" ? ok(noChecks()) : err(sha.error);
		const pipelines = await this.request(ref, {
			path: "pipelines",
			context: "GET /pipelines",
			query: { sha: sha.value, order_by: "id", sort: "desc", per_page: "1" },
		});
		if (!pipelines.ok) return err(toForgeError(pipelines.error));
		const newest = await readJson(pipelines.response);
		const id = Array.isArray(newest) ? (newest[0] as { id?: unknown } | undefined)?.id : undefined;
		if (typeof id !== "number") return ok(noChecks());
		const jobs = await this.request(ref, {
			path: `pipelines/${id}/jobs`,
			context: `GET /pipelines/${id}/jobs`,
			query: { per_page: "100" },
		});
		if (!jobs.ok) return err(toForgeError(jobs.error));
		const rows = await readJson(jobs.response);
		const runs = (Array.isArray(rows) ? rows : [])
			.map(parseJob)
			.filter((r): r is CheckRun => r !== null);
		return ok({ conclusion: rollUpJobs(runs), runs });
	}

	/** Best-effort by contract: any failure degrades to ok with `null`. */
	async fetchJobLogTail(
		ref: RepoRef,
		jobId: string,
		maxBytes: number,
	): Promise<ForgeResult<string | null>> {
		const token = this.credential(ref);
		if (!token.ok || maxBytes <= 0) return ok(null);
		const result = await this.request(ref, {
			path: `jobs/${encodeURIComponent(jobId)}/trace`,
			accept: "text/plain",
			context: `GET /jobs/${jobId}/trace`,
		});
		if (!result.ok) return ok(null);
		const text = (await readText(result.response)).replace(/\s+$/, "");
		if (text === "") return ok(null);
		return ok(text.length <= maxBytes ? text : text.slice(text.length - maxBytes));
	}

	async deleteBranch(ref: RepoRef, branch: string): Promise<ForgeResult<void>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const result = await this.request(ref, {
			path: `repository/branches/${encodeURIComponent(branch)}`,
			method: "DELETE",
			context: `DELETE /repository/branches/${branch}`,
		});
		if (!result.ok) return err(toForgeError(result.error));
		return ok(undefined);
	}

	/**
	 * The token's own user. A project or group access token is a bot user
	 * whose commit email is a noreply address on the instance.
	 */
	async botIdentity(): Promise<ForgeResult<GitIdentity>> {
		if (this.token === "") {
			return err({ kind: "no_credential", detail: "no GitLab credential configured" });
		}
		const result = await this.call({ url: `${this.apiBase()}/user`, context: "GET /user" });
		if (!result.ok) return err(toForgeError(result.error));
		const user = (await readJson(result.response)) as Record<string, unknown> | null;
		const name = firstString(user?.name, user?.username);
		const email = firstString(user?.commit_email, user?.email, user?.public_email);
		if (name === null || email === null) {
			return err({
				kind: "unsupported",
				detail: "GET /user names no commit email — warren names the author via WARREN_GIT_AUTHOR_*",
			});
		}
		return ok({ name, email });
	}

	/** A token has no installation scope (§5): the repo picker falls back to URL paste. */
	listInstallationRepos(): Promise<ForgeResult<readonly ForgeRepoListing[]>> {
		return Promise.resolve(
			err({
				kind: "unsupported",
				detail: "GitLabForge has no installation scope — no repository listing (§5)",
			}),
		);
	}

	/* ------------------------------------------------------------------- */

	private credential(ref: RepoRef): ForgeResult<string> {
		if (this.token === "") {
			return err({
				kind: "no_credential",
				detail: `no GitLab credential configured; cannot call the forge for ${ref.key}`,
			});
		}
		return ok(this.token);
	}

	private async branchTip(ref: RepoRef, branch: string): Promise<ForgeResult<string>> {
		const result = await this.request(ref, {
			path: `repository/branches/${encodeURIComponent(branch)}`,
			context: `GET /repository/branches/${branch}`,
		});
		if (!result.ok) return err(toForgeError(result.error));
		const body = (await readJson(result.response)) as { commit?: { id?: unknown } } | null;
		const id = body?.commit?.id;
		if (typeof id !== "string") {
			return err({ kind: "http_error", detail: `branch ${branch} answered without a commit` });
		}
		return ok(id);
	}

	private apiBase(): string {
		return `${this.instance.origin}${this.instance.basePath}/api/v4`;
	}

	/** One request against the project the ref names. */
	private request(ref: RepoRef, input: RequestInput): Promise<GitLabTransportResult> {
		const project = encodeURIComponent(unpackGitLabRef(ref));
		const query = input.query === undefined ? "" : `?${new URLSearchParams(input.query)}`;
		return this.call({
			...input,
			url: `${this.apiBase()}/projects/${project}/${input.path}${query}`,
		});
	}

	private call(input: Omit<RequestInput, "path" | "query"> & { url: string }) {
		return requestGitLab({
			url: input.url,
			method: input.method ?? "GET",
			token: this.token,
			context: input.context,
			fetch: this.fetch,
			...(input.body !== undefined ? { body: input.body } : {}),
			...(input.accept !== undefined ? { accept: input.accept } : {}),
			...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
		});
	}

	private toRef(ref: RepoRef, iid: number): PullRequestRef {
		const { origin, basePath } = this.instance;
		return {
			forge: GITLAB_FORGE_KIND,
			key: `${ref.key}!${iid}`,
			number: iid,
			// Built here rather than read off `web_url`, so it always parses
			// back to the same ref: the ci-fixer hands this URL to parseRepoRef.
			webUrl: `${origin}${basePath}/${unpackGitLabRef(ref)}/-/merge_requests/${iid}`,
		};
	}
}

/** A ref with no pipeline yet: nothing to classify. */
function noChecks(): CheckSummary {
	return { conclusion: "unknown", runs: [] };
}

function mergeRequestIid(json: MergeRequestJson): number | null {
	return typeof json.iid === "number" && json.iid > 0 ? json.iid : null;
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return null;
}

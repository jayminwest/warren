/**
 * AdoForge — the Azure DevOps Repos arm of the `Forge` contract
 * (forge-contract.md §1), behind `WARREN_FORGE=ado`.
 *
 * What this provider is:
 *   - `parseRepoRef` absorbs the Azure DevOps clone-URL grammars
 *     (`./repo-ref.ts`). It NEVER throws and returns `null` for foreign
 *     hosts. The three-part org/project/repo coordinate packs into
 *     `RepoRef.key`; the contract gains no field for it.
 *   - `openPullRequest` is idempotent by contract: Azure DevOps answers a
 *     duplicate with 409 (TF401179), which resolves to the existing PR
 *     through `findPullRequest`. Azure DevOps pull requests only ever
 *     target the repository the branch lives in, so a fork-qualified
 *     head (`owner:branch`) is `unsupported` rather than mis-targeted.
 *   - `gitCredential` returns the configured personal access token with
 *     `expiresAt: null` (§4 — static lifetime skips the re-mint path).
 *     Azure DevOps ignores the basic-auth username; `pat` names the scheme.
 *   - `listChecks` reads Pipelines builds for the commit and
 *     `fetchJobLogTail` tails the failed task's log (`./checks.ts`).
 *
 * Capabilities (§5): `checkRuns` and `jobLogs` are true because a PAT
 * with Build (read) reaches the Pipelines API. `botIdentity` is false:
 * the token authorizes but does not name the author (§6.8), so warren
 * keeps naming commits via `WARREN_GIT_AUTHOR_*`.
 *
 * Seam discipline (§2.2): every method returns `ForgeResult<T>` and never
 * throws. Boot-time failures live in `src/forge/registry.ts`.
 */

import type {
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
import { readJson } from "../github/readers.ts";
import { scanChecks, scanJobLogTail } from "./build-scan.ts";
import { branchFilter } from "./checks.ts";
import { ADO_API_VERSION, err, ok, requestAdo, toForgeError } from "./http.ts";
import {
	ADO_FORGE_KIND,
	ADO_HOST,
	type AdoCoordinate,
	adoRepoLayout,
	parseAdoRepoRef,
	unpackAdoRef,
} from "./repo-ref.ts";

export { ADO_FORGE_KIND } from "./repo-ref.ts";

/** Basic-auth username sent beside the PAT; Azure DevOps ignores it. */
const PAT_USERNAME = "pat";

/** The all-zero object id that deletes a ref through the refs API. */
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";

/**
 * Azure DevOps rejects a pull-request description longer than 4000
 * characters (`InvalidArgumentValueException`). GitHub allows 65536, and
 * the domain composes the body against that headroom, so the arm cuts the
 * body to fit rather than fail the PR.
 */
export const ADO_PR_DESCRIPTION_MAX = 4000;

const TRUNCATION_MARKER = "\n\n…(description truncated at Azure DevOps' 4000-character limit)";

/** Kept from the end of an over-long body: warren appends machine-read fragments (preview markers) there. */
const TAIL_KEEP = 1000;

/**
 * Cut a PR description to the Azure DevOps limit, marking the cut. The
 * cut removes the middle, not the end: warren appends machine-read
 * fragments (the preview block, run metadata) to the tail, and a
 * head-only slice would silently drop them.
 */
export function fitPrDescription(body: string): string {
	if (body.length <= ADO_PR_DESCRIPTION_MAX) return body;
	const tail = body.slice(-TAIL_KEEP);
	const keep = ADO_PR_DESCRIPTION_MAX - TRUNCATION_MARKER.length - tail.length;
	return body.slice(0, keep) + TRUNCATION_MARKER + tail;
}

export interface AdoForgeOptions {
	/** The personal access token. Empty string → methods return `no_credential`. */
	readonly token: string;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Per-request deadline override. */
	readonly timeoutMs?: number;
}

interface AdoPrJson {
	readonly pullRequestId?: unknown;
	readonly status?: unknown;
	readonly closedDate?: unknown;
	readonly sourceRefName?: unknown;
	readonly targetRefName?: unknown;
	readonly lastMergeSourceCommit?: unknown;
}

/**
 * Azure DevOps refuses a refs update with `success: false` plus an
 * `updateStatus` naming why. Only the concurrency shapes are conflicts;
 * a permissions refusal must surface as `forbidden` so the operator sees
 * the PAT scope problem instead of a phantom race.
 */
function refUpdateErrorKind(status: string): "conflict" | "forbidden" | "http_error" {
	if (status === "writePermissionRequired" || status === "permissionRequired") return "forbidden";
	if (status === "staleOldObjectId" || status === "forcePushRequired") return "conflict";
	if (status === "invalidRefName") return "http_error";
	return "conflict";
}

function branchName(refName: unknown): string {
	return typeof refName === "string" ? refName.replace(/^refs\/heads\//, "") : "";
}

export class AdoForge implements Forge {
	readonly capabilities: ForgeCapabilities;

	private readonly token: string;
	private readonly fetch: typeof fetch;
	private readonly timeoutMs: number | undefined;
	/** `RepoRef.key` → repository GUID, resolved once per process. */
	private readonly repoGuids = new Map<string, string>();

	constructor(options: AdoForgeOptions) {
		this.token = options.token;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs;
		this.capabilities = {
			checkRuns: true,
			jobLogs: true,
			pullRequestBodyEdit: true,
			branchDelete: true,
			// The token authorizes; it does not name the author (§6.8).
			botIdentity: false,
			// A PAT has no installation scope (§5): no repo listing.
			installationRepos: false,
			credentialLifetime: "static",
		};
	}

	parseRepoRef(cloneUrl: string): RepoRef | null {
		return parseAdoRepoRef(cloneUrl);
	}

	repoLayout(cloneUrl: string): { owner: string; name: string } | null {
		return adoRepoLayout(cloneUrl);
	}

	gitCredential(ref: RepoRef): Promise<ForgeResult<GitCredential>> {
		const token = this.credential(ref);
		if (!token.ok) return Promise.resolve(err(token.error));
		return Promise.resolve(ok({ username: PAT_USERNAME, secret: token.value, expiresAt: null }));
	}

	async openPullRequest(ref: RepoRef, req: PullRequestDraft): Promise<ForgeResult<PullRequestRef>> {
		if (req.headBranch.includes(":")) {
			return err({
				kind: "unsupported",
				detail: `Azure DevOps pull requests cannot target a branch outside the repository: ${req.headBranch}`,
			});
		}
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const result = await this.request(ref, {
			path: "pullrequests",
			method: "POST",
			context: "POST /pullrequests",
			body: {
				sourceRefName: branchFilter(req.headBranch),
				targetRefName: branchFilter(req.baseBranch),
				title: req.title,
				description: fitPrDescription(req.body),
				...(req.draft !== undefined ? { isDraft: req.draft } : {}),
			},
		});
		if (!result.ok) {
			// Idempotency (§1): a 409 "already exists" resolves to the existing PR.
			if (result.error.status === 409) {
				const existing = await this.findPullRequest(ref, {
					headBranch: req.headBranch,
					baseBranch: req.baseBranch,
				});
				if (existing.ok && existing.value !== null) return ok(existing.value);
			}
			return err(toForgeError(result.error));
		}
		const created = (await readJson(result.response)) as AdoPrJson | null;
		return this.prRefResult(ref, created, "POST /pullrequests");
	}

	async findPullRequest(
		ref: RepoRef,
		q: PullRequestQuery,
	): Promise<ForgeResult<PullRequestRef | null>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const state = q.state ?? "open";
		const result = await this.request(ref, {
			path: "pullrequests",
			context: "GET /pullrequests",
			query: {
				"searchCriteria.sourceRefName": branchFilter(q.headBranch),
				"searchCriteria.targetRefName": branchFilter(q.baseBranch),
				"searchCriteria.status": state === "open" ? "active" : "all",
				$top: "100",
			},
		});
		if (!result.ok) return err(toForgeError(result.error));
		const body = (await readJson(result.response)) as { value?: unknown } | null;
		if (!Array.isArray(body?.value)) {
			return err({ kind: "http_error", detail: "GET /pullrequests returned a non-list body" });
		}
		for (const item of body.value as AdoPrJson[]) {
			if (state === "closed" && item.status === "active") continue;
			const number = prNumber(item);
			if (number !== null) return ok(this.toRef(ref, number));
		}
		return ok(null);
	}

	async getPullRequest(ref: RepoRef, pr: PullRequestRef): Promise<ForgeResult<PullRequestState>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const result = await this.request(ref, {
			path: `pullrequests/${pr.number}`,
			context: `GET /pullrequests/${pr.number}`,
		});
		if (!result.ok) return err(toForgeError(result.error));
		const body = (await readJson(result.response)) as AdoPrJson | null;
		if (body === null) {
			return err({ kind: "http_error", detail: `GET /pullrequests/${pr.number} returned no body` });
		}
		const closedAtRaw = typeof body.closedDate === "string" ? Date.parse(body.closedDate) : null;
		const closedAt = closedAtRaw !== null && Number.isFinite(closedAtRaw) ? closedAtRaw : null;
		const lifecycle =
			body.status === "completed"
				? "merged"
				: body.status === "abandoned"
					? "closed_unmerged"
					: "open";
		const head = body.lastMergeSourceCommit as { commitId?: unknown } | undefined;
		return ok({
			lifecycle,
			mergedAt: lifecycle === "merged" ? closedAt : null,
			headCommit: typeof head?.commitId === "string" ? head.commitId : "",
			baseBranch: branchName(body.targetRefName),
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
			path: `pullrequests/${pr.number}`,
			method: "PATCH",
			context: `PATCH /pullrequests/${pr.number}`,
			body: { description: fitPrDescription(body) },
		});
		if (!result.ok) return err(toForgeError(result.error));
		return ok(undefined);
	}

	async listChecks(ref: RepoRef, commit: string): Promise<ForgeResult<CheckSummary>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		return scanChecks(this.scanDeps(ref), commit);
	}

	/** Best-effort by contract: any failure degrades to ok with `null`. */
	async fetchJobLogTail(
		ref: RepoRef,
		jobId: string,
		maxBytes: number,
	): Promise<ForgeResult<string | null>> {
		const token = this.credential(ref);
		if (!token.ok) return ok(null);
		return scanJobLogTail(this.scanDeps(ref), jobId, maxBytes);
	}

	/** The build-scan module's view of this instance, bound to one ref. */
	private scanDeps(ref: RepoRef) {
		return {
			request: (input: Parameters<AdoForge["request"]>[1]) => this.request(ref, input),
			repo: unpackAdoRef(ref).repo,
			refKey: ref.key,
			repoGuids: this.repoGuids,
		};
	}

	async deleteBranch(ref: RepoRef, branch: string): Promise<ForgeResult<void>> {
		const token = this.credential(ref);
		if (!token.ok) return err(token.error);
		const lookup = await this.request(ref, {
			path: "refs",
			context: `GET /refs?filter=heads/${branch}`,
			query: { filter: `heads/${branch}` },
		});
		if (!lookup.ok) return err(toForgeError(lookup.error));
		const refs = (await readJson(lookup.response)) as { value?: unknown } | null;
		const list = Array.isArray(refs?.value)
			? (refs.value as { name?: unknown; objectId?: unknown }[])
			: [];
		const match = list.find((r) => r.name === branchFilter(branch));
		if (match === undefined || typeof match.objectId !== "string") {
			return err({ kind: "not_found", detail: `branch ${branch} does not exist on the remote` });
		}
		const update = await this.request(ref, {
			path: "refs",
			method: "POST",
			context: `POST /refs (delete heads/${branch})`,
			body: [
				{ name: branchFilter(branch), oldObjectId: match.objectId, newObjectId: ZERO_OBJECT_ID },
			],
		});
		if (!update.ok) return err(toForgeError(update.error));
		const outcome = (await readJson(update.response)) as { value?: unknown } | null;
		const first = Array.isArray(outcome?.value)
			? (outcome.value[0] as { success?: unknown; updateStatus?: unknown })
			: undefined;
		if (first?.success !== true) {
			const status = String(first?.updateStatus ?? "no result");
			return err({
				kind: refUpdateErrorKind(status),
				detail: `deleting heads/${branch} was refused: ${status}`,
			});
		}
		return ok(undefined);
	}

	/** PAT mode holds no bot identity (§5): the domain falls back to env. */
	botIdentity(): Promise<ForgeResult<GitIdentity>> {
		return Promise.resolve(
			err({
				kind: "unsupported",
				detail:
					"AdoForge holds no bot identity — warren names the author via WARREN_GIT_AUTHOR_* (§6.8)",
			}),
		);
	}

	/** A PAT has no installation scope (§5): the repo picker falls back to URL paste. */
	listInstallationRepos(): Promise<ForgeResult<readonly ForgeRepoListing[]>> {
		return Promise.resolve(
			err({
				kind: "unsupported",
				detail: "AdoForge has no installation scope — no repository listing (§5)",
			}),
		);
	}

	/* ------------------------------------------------------------------- */

	private credential(ref: RepoRef): ForgeResult<string> {
		if (this.token === "") {
			return err({
				kind: "no_credential",
				detail: `no Azure DevOps credential configured; cannot call the forge for ${ref.key}`,
			});
		}
		return ok(this.token);
	}

	/**
	 * One request against the project-scoped API. `area: "git"` (the
	 * default) targets the repository's git resources; `area: "build"`
	 * targets the project's Pipelines resources.
	 */
	private request(
		ref: RepoRef,
		input: {
			path: string;
			area?: "git" | "build" | "project-git";
			method?: "GET" | "POST" | "PATCH";
			body?: unknown;
			query?: Record<string, string>;
			accept?: string;
			context: string;
		},
	) {
		const coordinate = unpackAdoRef(ref);
		const params = new URLSearchParams({ ...input.query, "api-version": ADO_API_VERSION });
		const resource =
			input.area === "build"
				? `_apis/build/${input.path}`
				: input.area === "project-git"
					? `_apis/git/${input.path}`
					: `_apis/git/repositories/${encodeURIComponent(coordinate.repo)}/${input.path}`;
		return requestAdo({
			url: `${projectUrl(coordinate)}/${resource}?${params.toString()}`,
			method: input.method ?? "GET",
			token: this.token,
			context: input.context,
			fetch: this.fetch,
			...(input.body !== undefined ? { body: input.body } : {}),
			...(input.accept !== undefined ? { accept: input.accept } : {}),
			...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
		});
	}

	private prRefResult(
		ref: RepoRef,
		json: AdoPrJson | null,
		context: string,
	): ForgeResult<PullRequestRef> {
		const number = json === null ? null : prNumber(json);
		if (number === null) {
			return err({ kind: "http_error", detail: `${context} returned no pull request id` });
		}
		return ok(this.toRef(ref, number));
	}

	private toRef(ref: RepoRef, number: number): PullRequestRef {
		const coordinate = unpackAdoRef(ref);
		return {
			forge: ADO_FORGE_KIND,
			key: `${ref.key}#${number}`,
			number,
			webUrl: `${projectUrl(coordinate)}/_git/${encodeURIComponent(coordinate.repo)}/pullrequest/${number}`,
		};
	}
}

function prNumber(json: AdoPrJson): number | null {
	return typeof json.pullRequestId === "number" && json.pullRequestId > 0
		? json.pullRequestId
		: null;
}

function projectUrl(c: AdoCoordinate): string {
	return `https://${ADO_HOST}/${c.org}/${encodeURIComponent(c.project)}`;
}

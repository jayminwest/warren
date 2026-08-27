/**
 * FakeForge — implementation #2 of the `Forge` contract (plan pl-d1c9 step
 * 7, forge-contract.md §1.1/§5).
 *
 * PRODUCTION code under `src/forge/fake/`, selected by `WARREN_FORGE=fake` —
 * deliberately NOT a test-helpers file: the layer and wire gates exempt test
 * paths, so a fake living there would be invisible to the very rule this
 * phase exists to prove. It backs the campaign's first falsification test
 * (§0): a FakeForge project completes dispatch → reap → push → PR with zero
 * domain-code changes.
 *
 * The fake owns the `fake://` clone-URL grammar, keeps an in-memory PR store
 * (`store.ts`), reports every capability true with a `static` credential
 * lifetime, and synthesizes job logs. Seeding seams (`markMerged`,
 * `setChecks`, `isBranchDeleted`) are public so tests and the acceptance
 * harness drive state transitions GitHub would drive externally.
 */

import type {
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
import { FakeForgeStore, rollUpChecks } from "./store.ts";

/** Registry key this forge answers to (`FORGE_KINDS`). */
export const FAKE_FORGE_KIND = "fake";

/** The clone-URL scheme the fake owns: `fake://<path>`. */
export const FAKE_CLONE_URL_SCHEME = "fake://";

/** The PR-web-URL suffix `toRef` mints and `parseRepoRef` strips. */
const FAKE_PR_URL_SUFFIX = /\/pulls\/\d+$/;

export interface FakeForgeOptions {
	/** Shared state; a fresh store when omitted. */
	readonly store?: FakeForgeStore;
	/** Clock seam for `mergedAt` and commit stamping; defaults to Date.now. */
	readonly now?: () => number;
}

function ok<T>(value: T): ForgeResult<T> {
	return { ok: true, value };
}

function notFound<T>(detail: string): ForgeResult<T> {
	return { ok: false, error: { kind: "not_found", detail } };
}

export class FakeForge implements Forge {
	readonly capabilities: ForgeCapabilities = {
		checkRuns: true,
		jobLogs: true,
		pullRequestBodyEdit: true,
		branchDelete: true,
		botIdentity: true,
		installationRepos: false,
		credentialLifetime: "static",
	};

	/** Exposed for the seeding seams; never serialized across the seam. */
	readonly store: FakeForgeStore;
	private readonly now: () => number;

	constructor(options: FakeForgeOptions = {}) {
		this.store = options.store ?? new FakeForgeStore();
		this.now = options.now ?? Date.now;
	}

	/**
	 * The `fake://` grammar: `fake://<path>` parses to a ref whose key is the
	 * path verbatim. Anything else returns `null` so the registry tries the
	 * next forge — this method NEVER throws (§1).
	 */
	parseRepoRef(cloneUrl: string): RepoRef | null {
		if (!cloneUrl.startsWith(FAKE_CLONE_URL_SCHEME)) return null;
		let key = cloneUrl.slice(FAKE_CLONE_URL_SCHEME.length);
		if (key.length === 0) return null;
		// warren-63e7: accept the fake's own PR web URLs (`fake://<path>/pulls/<n>`,
		// see toRef) and resolve them to the repo ref — the same grammar
		// tolerance GitHubForge's parseRepoRef has for `/pull/<n>` URLs. The
		// plan-run merge gate polls the stored webUrl, so the round-trip must
		// land back on the repo key the store is indexed by.
		key = key.replace(FAKE_PR_URL_SUFFIX, "");
		if (key.length === 0) return null;
		return { forge: FAKE_FORGE_KIND, key };
	}

	/** Static credential (§5): no expiry, so the domain skips the re-mint. */
	gitCredential(_ref: RepoRef): Promise<ForgeResult<GitCredential>> {
		return Promise.resolve(ok({ username: "fake", secret: "fake-credential", expiresAt: null }));
	}

	async openPullRequest(ref: RepoRef, req: PullRequestDraft): Promise<ForgeResult<PullRequestRef>> {
		const record = this.store.openPr(ref.key, req, this.headCommit(req.headBranch));
		return ok(this.toRef(ref, record.number));
	}

	async findPullRequest(
		ref: RepoRef,
		q: PullRequestQuery,
	): Promise<ForgeResult<PullRequestRef | null>> {
		const record = this.store.findPr(ref.key, q);
		return ok(record === null ? null : this.toRef(ref, record.number));
	}

	async getPullRequest(ref: RepoRef, pr: PullRequestRef): Promise<ForgeResult<PullRequestState>> {
		const record = this.store.getPr(ref.key, pr.number);
		if (record === null) {
			return notFound(`fake forge has no pull request #${pr.number} for ${ref.key}`);
		}
		return ok({
			lifecycle: record.lifecycle,
			mergedAt: record.mergedAt,
			headCommit: record.headCommit,
			baseBranch: record.baseBranch,
		});
	}

	async setPullRequestBody(
		ref: RepoRef,
		pr: PullRequestRef,
		body: string,
	): Promise<ForgeResult<void>> {
		const record = this.store.setPrBody(ref.key, pr.number, body);
		if (record === null) {
			return notFound(`fake forge has no pull request #${pr.number} for ${ref.key}`);
		}
		return ok(undefined);
	}

	async listChecks(ref: RepoRef, commit: string): Promise<ForgeResult<CheckSummary>> {
		const runs = this.store.checksFor(ref.key, commit);
		return ok({ conclusion: rollUpChecks(runs), runs });
	}

	/**
	 * Synthetic job logs (§5: `jobLogs` is "synthetic" for the fake). Any
	 * known job id yields a deterministic log tailed to `maxBytes`; an empty
	 * id is the fake's "cannot supply logs" case and returns ok with `null`,
	 * per the contract's best-effort rule.
	 */
	fetchJobLogTail(
		_ref: RepoRef,
		jobId: string,
		maxBytes: number,
	): Promise<ForgeResult<string | null>> {
		if (jobId.length === 0) return Promise.resolve(ok(null));
		const lines: string[] = [];
		for (let i = 1; i <= 20; i++) {
			lines.push(`[fake-forge] job ${jobId} log line ${i}`);
		}
		let log = `${lines.join("\n")}\n`;
		if (maxBytes >= 0 && log.length > maxBytes) {
			log = log.slice(log.length - maxBytes);
		}
		return Promise.resolve(ok(log));
	}

	async deleteBranch(ref: RepoRef, branch: string): Promise<ForgeResult<void>> {
		this.store.deleteBranch(ref.key, branch);
		return ok(undefined);
	}

	botIdentity(): Promise<ForgeResult<GitIdentity>> {
		return Promise.resolve(
			ok({ name: "warren-fake-forge[bot]", email: "fake-forge@warren.invalid" }),
		);
	}

	/** The fake owns no GitHub installation — no repo listing (warren-2601). */
	listInstallationRepos(): Promise<ForgeResult<readonly ForgeRepoListing[]>> {
		return Promise.resolve({
			ok: false,
			error: {
				kind: "unsupported",
				detail: "FakeForge has no installation — no repository listing",
			},
		} satisfies ForgeResult<readonly ForgeRepoListing[]>);
	}

	// --- Seeding seams (FakeForge public API beyond the Forge interface) ---

	/** Transition an open PR to merged, as the auto-merge workflow would. */
	markMerged(ref: RepoRef, pr: PullRequestRef): boolean {
		return this.store.markMerged(ref.key, pr.number, this.now()) !== null;
	}

	/** Transition an open PR to closed-unmerged (a human closed the tab). */
	markClosed(ref: RepoRef, pr: PullRequestRef): boolean {
		return this.store.markClosed(ref.key, pr.number) !== null;
	}

	/** Install the check runs `listChecks` reports for a commit. */
	setChecks(ref: RepoRef, commit: string, runs: CheckRun[]): void {
		this.store.setChecks(ref.key, commit, runs);
	}

	/** Acceptance cleanup assertion: was this branch deleted through the seam? */
	isBranchDeleted(ref: RepoRef, branch: string): boolean {
		return this.store.isBranchDeleted(ref.key, branch);
	}

	/** Deterministic stand-in for a pushed head commit sha. */
	private headCommit(branch: string): string {
		return `fake-head-${branch}`;
	}

	private toRef(ref: RepoRef, number: number): PullRequestRef {
		return {
			forge: FAKE_FORGE_KIND,
			key: `${ref.key}#${number}`,
			number,
			webUrl: `${FAKE_CLONE_URL_SCHEME}${ref.key}/pulls/${number}`,
		};
	}
}

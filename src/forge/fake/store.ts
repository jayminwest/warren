/**
 * FakeForge's in-memory state (plan pl-d1c9 step 7).
 *
 * Extracted from `fake-forge.ts` so the store is a plain data structure the
 * acceptance harness and the conformance tests can seed directly, while the
 * `Forge` implementation stays a thin behavioral layer over it. Everything
 * is keyed by the `RepoRef.key` the fake's own `parseRepoRef` minted — the
 * store never sees a URL.
 */

import type {
	CheckRun,
	PullRequestDraft,
	PullRequestLifecycle,
	PullRequestQuery,
} from "../contract.ts";

/** One stored pull request. `body` mutates via `setPullRequestBody`. */
export interface FakePullRequestRecord {
	readonly number: number;
	readonly headBranch: string;
	readonly baseBranch: string;
	readonly draft: boolean;
	title: string;
	body: string;
	lifecycle: PullRequestLifecycle;
	/** epoch ms; set by `markMerged` */
	mergedAt: number | null;
	headCommit: string;
}

/** Conclusions that roll a commit up to `failing` (Actions vocabulary). */
const FAILING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

export class FakeForgeStore {
	private readonly prsByRepo = new Map<string, FakePullRequestRecord[]>();
	private readonly checksByCommit = new Map<string, CheckRun[]>();
	private readonly deletedBranchesByRepo = new Map<string, Set<string>>();
	private nextPrNumber = 1;

	private prs(repoKey: string): FakePullRequestRecord[] {
		let list = this.prsByRepo.get(repoKey);
		if (list === undefined) {
			list = [];
			this.prsByRepo.set(repoKey, list);
		}
		return list;
	}

	/**
	 * Idempotent open: an existing OPEN PR for the same head/base pair is
	 * returned as-is (the contract's duplicate-resolution rule, §1), so the
	 * fake exercises the same path GitHub's 422-then-search dance hides.
	 */
	openPr(repoKey: string, draft: PullRequestDraft, headCommit: string): FakePullRequestRecord {
		const existing = this.prs(repoKey).find(
			(pr) =>
				pr.lifecycle === "open" &&
				pr.headBranch === draft.headBranch &&
				pr.baseBranch === draft.baseBranch,
		);
		if (existing !== undefined) return existing;
		const record: FakePullRequestRecord = {
			number: this.nextPrNumber++,
			headBranch: draft.headBranch,
			baseBranch: draft.baseBranch,
			draft: draft.draft ?? false,
			title: draft.title,
			body: draft.body,
			lifecycle: "open",
			mergedAt: null,
			headCommit,
		};
		this.prs(repoKey).push(record);
		return record;
	}

	findPr(repoKey: string, q: PullRequestQuery): FakePullRequestRecord | null {
		const state = q.state ?? "open";
		const match = this.prs(repoKey).find((pr) => {
			if (pr.headBranch !== q.headBranch || pr.baseBranch !== q.baseBranch) return false;
			if (state === "all") return true;
			if (state === "open") return pr.lifecycle === "open";
			return pr.lifecycle !== "open";
		});
		return match ?? null;
	}

	getPr(repoKey: string, number: number): FakePullRequestRecord | null {
		return this.prs(repoKey).find((pr) => pr.number === number) ?? null;
	}

	/** Test/acceptance seeding seam: transition an open PR to merged. */
	markMerged(repoKey: string, number: number, mergedAt: number): FakePullRequestRecord | null {
		const pr = this.getPr(repoKey, number);
		if (pr === null) return null;
		pr.lifecycle = "merged";
		pr.mergedAt = mergedAt;
		return pr;
	}

	/** Test/acceptance seeding seam: install the check runs for a commit. */
	setChecks(repoKey: string, commit: string, runs: CheckRun[]): void {
		this.checksByCommit.set(
			`${repoKey}@${commit}`,
			runs.map((run) => ({ ...run })),
		);
	}

	checksFor(repoKey: string, commit: string): CheckRun[] {
		return (this.checksByCommit.get(`${repoKey}@${commit}`) ?? []).map((run) => ({ ...run }));
	}

	deleteBranch(repoKey: string, branch: string): void {
		let set = this.deletedBranchesByRepo.get(repoKey);
		if (set === undefined) {
			set = new Set();
			this.deletedBranchesByRepo.set(repoKey, set);
		}
		set.add(branch);
	}

	isBranchDeleted(repoKey: string, branch: string): boolean {
		return this.deletedBranchesByRepo.get(repoKey)?.has(branch) ?? false;
	}
}

/**
 * Roll a commit's check runs up to the domain's decision input
 * (`CheckSummary.conclusion`): no runs is `unknown`; anything incomplete is
 * `pending`; a failing conclusion is `failing`; otherwise `passing`.
 */
export function rollUpChecks(
	runs: readonly CheckRun[],
): "pending" | "passing" | "failing" | "unknown" {
	if (runs.length === 0) return "unknown";
	if (runs.some((run) => run.status !== "completed")) return "pending";
	if (runs.some((run) => run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion))) {
		return "failing";
	}
	return "passing";
}

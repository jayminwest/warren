/**
 * FakeForge's in-memory state (plan pl-d1c9 step 7).
 *
 * Extracted from `fake-forge.ts` so the store is a plain data structure the
 * acceptance harness and the conformance tests can seed directly, while the
 * `Forge` implementation stays a thin behavioral layer over it. Everything
 * is keyed by the `RepoRef.key` the fake's own `parseRepoRef` minted — the
 * store never sees a URL.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** Env var that points the fake arm at a file-backed store (see below). */
export const FAKE_FORGE_STATE_FILE_ENV = "WARREN_FAKE_FORGE_STATE_FILE";

/**
 * On-disk serialization shape for the cross-process seam. The acceptance
 * harness boots warren as a SUBPROCESS, so it cannot call the in-memory
 * seeding seams (`markMerged` & friends) directly. When the boot env
 * carries `WARREN_FAKE_FORGE_STATE_FILE=<path>` (registry.ts resolves it),
 * the store reloads this JSON document before every read and rewrites it
 * (atomically, tmp+rename) after every mutation — the harness marks PRs
 * merged by editing the file, exactly the role GitHub's auto-merge
 * workflow plays for the real forge (warren-2600).
 */
export interface FakeForgeStateFile {
	readonly nextPrNumber: number;
	readonly prs: Record<string, FakePullRequestRecord[]>;
	readonly checks: Record<string, CheckRun[]>;
	readonly deletedBranches: Record<string, string[]>;
}

export interface FakeForgeStoreOptions {
	/**
	 * OPTIONAL backing file for the cross-process acceptance seam. Omit
	 * (the default) for the pure in-memory store unit tests use.
	 */
	readonly stateFile?: string;
}

export class FakeForgeStore {
	private prsByRepo = new Map<string, FakePullRequestRecord[]>();
	private checksByCommit = new Map<string, CheckRun[]>();
	private deletedBranchesByRepo = new Map<string, Set<string>>();
	private nextPrNumber = 1;
	private readonly stateFile: string | undefined;

	constructor(options: FakeForgeStoreOptions = {}) {
		this.stateFile = options.stateFile;
	}

	/**
	 * Pull external edits (the harness's markMerged writes) into memory.
	 * A missing or unparseable file keeps the in-memory state — the file
	 * appears only after the first mutation persists it, and a torn read
	 * must never crash a poll loop.
	 */
	private reload(): void {
		if (this.stateFile === undefined || !existsSync(this.stateFile)) return;
		let parsed: FakeForgeStateFile;
		try {
			parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as FakeForgeStateFile;
		} catch {
			return;
		}
		this.prsByRepo = new Map(
			Object.entries(parsed.prs ?? {}).map(([key, list]) => [key, list.map((r) => ({ ...r }))]),
		);
		this.checksByCommit = new Map(
			Object.entries(parsed.checks ?? {}).map(([key, runs]) => [key, runs.map((r) => ({ ...r }))]),
		);
		this.deletedBranchesByRepo = new Map(
			Object.entries(parsed.deletedBranches ?? {}).map(([key, list]) => [key, new Set(list)]),
		);
		if (typeof parsed.nextPrNumber === "number" && parsed.nextPrNumber > this.nextPrNumber) {
			this.nextPrNumber = parsed.nextPrNumber;
		}
	}

	/** Atomic tmp+rename persist so a concurrent reader never sees a torn write. */
	private persist(): void {
		if (this.stateFile === undefined) return;
		const state: FakeForgeStateFile = {
			nextPrNumber: this.nextPrNumber,
			prs: Object.fromEntries(this.prsByRepo),
			checks: Object.fromEntries(this.checksByCommit),
			deletedBranches: Object.fromEntries(
				[...this.deletedBranchesByRepo].map(([key, set]) => [key, [...set]]),
			),
		};
		mkdirSync(dirname(this.stateFile), { recursive: true });
		const tmp = join(dirname(this.stateFile), `.${Date.now()}-${process.pid}.tmp`);
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
		renameSync(tmp, this.stateFile);
	}

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
		this.reload();
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
		this.persist();
		return record;
	}

	findPr(repoKey: string, q: PullRequestQuery): FakePullRequestRecord | null {
		this.reload();
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
		this.reload();
		return this.prs(repoKey).find((pr) => pr.number === number) ?? null;
	}

	/** Persisted body rewrite backing `Forge.setPullRequestBody`. */
	setPrBody(repoKey: string, number: number, body: string): FakePullRequestRecord | null {
		const pr = this.getPr(repoKey, number);
		if (pr === null) return null;
		pr.body = body;
		this.persist();
		return pr;
	}

	/** Test/acceptance seeding seam: transition an open PR to merged. */
	markMerged(repoKey: string, number: number, mergedAt: number): FakePullRequestRecord | null {
		const pr = this.getPr(repoKey, number);
		if (pr === null) return null;
		pr.lifecycle = "merged";
		pr.mergedAt = mergedAt;
		this.persist();
		return pr;
	}

	/** Test/acceptance seeding seam: transition an open PR to closed (unmerged). */
	markClosed(repoKey: string, number: number): FakePullRequestRecord | null {
		const pr = this.getPr(repoKey, number);
		if (pr === null) return null;
		pr.lifecycle = "closed_unmerged";
		this.persist();
		return pr;
	}

	/** Test/acceptance seeding seam: install the check runs for a commit. */
	setChecks(repoKey: string, commit: string, runs: CheckRun[]): void {
		this.reload();
		this.checksByCommit.set(
			`${repoKey}@${commit}`,
			runs.map((run) => ({ ...run })),
		);
		this.persist();
	}

	checksFor(repoKey: string, commit: string): CheckRun[] {
		this.reload();
		return (this.checksByCommit.get(`${repoKey}@${commit}`) ?? []).map((run) => ({ ...run }));
	}

	deleteBranch(repoKey: string, branch: string): void {
		this.reload();
		let set = this.deletedBranchesByRepo.get(repoKey);
		if (set === undefined) {
			set = new Set();
			this.deletedBranchesByRepo.set(repoKey, set);
		}
		set.add(branch);
		this.persist();
	}

	isBranchDeleted(repoKey: string, branch: string): boolean {
		this.reload();
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

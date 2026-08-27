/**
 * FakeForge-specific behaviours beyond the contract conformance suite in
 * `src/forge/contract.test.ts`: the `fake://` grammar, the seeding seams,
 * the check roll-up, and the synthetic job logs.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckRun } from "../contract.ts";
import { FAKE_CLONE_URL_SCHEME, FakeForge } from "./fake-forge.ts";
import { type FakeForgeStateFile, FakeForgeStore, rollUpChecks } from "./store.ts";

const DRAFT = {
	title: "t",
	body: "b",
	headBranch: "warren/run-1",
	baseBranch: "main",
};

function setup() {
	const forge = new FakeForge({ now: () => 1_700_000_000_000 });
	const ref = forge.parseRepoRef("fake://projects/widget");
	if (ref === null) throw new Error("unreachable");
	return { forge, ref };
}

describe("FakeForge.parseRepoRef", () => {
	test("owns the fake:// grammar and keeps the path as the key", () => {
		const forge = new FakeForge();
		expect(forge.parseRepoRef("fake://projects/widget")).toEqual({
			forge: "fake",
			key: "projects/widget",
		});
		expect(FAKE_CLONE_URL_SCHEME).toBe("fake://");
	});

	test("rejects foreign URLs and an empty path without throwing", () => {
		const forge = new FakeForge();
		expect(forge.parseRepoRef("https://github.com/o/r.git")).toBeNull();
		expect(forge.parseRepoRef("git@github.com:o/r.git")).toBeNull();
		expect(forge.parseRepoRef("fake://")).toBeNull();
		expect(forge.parseRepoRef("")).toBeNull();
	});
});

describe("FakeForge capabilities", () => {
	test("reports every capability true with a static credential lifetime", () => {
		expect(new FakeForge().capabilities).toEqual({
			checkRuns: true,
			jobLogs: true,
			pullRequestBodyEdit: true,
			branchDelete: true,
			botIdentity: true,
			installationRepos: false,
			credentialLifetime: "static",
		});
	});
});

describe("FakeForge pull-request store", () => {
	test("assigns incrementing numbers across repos", async () => {
		const { forge, ref } = setup();
		const other = forge.parseRepoRef("fake://projects/other");
		if (other === null) throw new Error("unreachable");
		const first = await forge.openPullRequest(ref, DRAFT);
		const second = await forge.openPullRequest(other, DRAFT);
		expect(first.ok && second.ok).toBe(true);
		if (first.ok && second.ok) expect(second.value.number).toBe(first.value.number + 1);
	});

	test("markMerged transitions lifecycle and stamps mergedAt from the clock", async () => {
		const { forge, ref } = setup();
		const opened = await forge.openPullRequest(ref, DRAFT);
		if (!opened.ok) throw new Error("unreachable");
		expect(forge.markMerged(ref, opened.value)).toBe(true);
		const state = await forge.getPullRequest(ref, opened.value);
		expect(state.ok).toBe(true);
		if (state.ok) {
			expect(state.value.lifecycle).toBe("merged");
			expect(state.value.mergedAt).toBe(1_700_000_000_000);
		}
		// A merged PR no longer matches the default open query…
		const open = await forge.findPullRequest(ref, {
			headBranch: DRAFT.headBranch,
			baseBranch: DRAFT.baseBranch,
		});
		expect(open.ok && open.value === null).toBe(true);
		// …but does match a closed/all query.
		const closed = await forge.findPullRequest(ref, {
			headBranch: DRAFT.headBranch,
			baseBranch: DRAFT.baseBranch,
			state: "closed",
		});
		expect(closed.ok && closed.value?.number === opened.value.number).toBe(true);
		// markMerged on an unknown PR reports false rather than throwing.
		expect(forge.markMerged(ref, { ...opened.value, number: 9999 })).toBe(false);
	});

	test("openPullRequest stays idempotent while the PR is open, then opens fresh after a merge", async () => {
		const { forge, ref } = setup();
		const first = await forge.openPullRequest(ref, DRAFT);
		if (!first.ok) throw new Error("unreachable");
		const again = await forge.openPullRequest(ref, { ...DRAFT, title: "renamed" });
		if (!again.ok) throw new Error("unreachable");
		expect(again.value.number).toBe(first.value.number);
		forge.markMerged(ref, first.value);
		const fresh = await forge.openPullRequest(ref, DRAFT);
		if (!fresh.ok) throw new Error("unreachable");
		expect(fresh.value.number).not.toBe(first.value.number);
	});

	test("setPullRequestBody rewrites the stored body", async () => {
		const { forge, ref } = setup();
		const opened = await forge.openPullRequest(ref, DRAFT);
		if (!opened.ok) throw new Error("unreachable");
		await forge.setPullRequestBody(ref, opened.value, "preview links here");
		const record = forge.store.getPr(ref.key, opened.value.number);
		expect(record?.body).toBe("preview links here");
	});
});

describe("FakeForge checks and logs", () => {
	test("setChecks seeds listChecks and returns defensive copies", async () => {
		const { forge, ref } = setup();
		const runs: CheckRun[] = [
			{
				name: "build",
				status: "completed",
				conclusion: "success",
				jobId: "j1",
				detailsUrl: null,
			},
		];
		forge.setChecks(ref, "sha-1", runs);
		const seeded = runs[0];
		if (seeded === undefined) throw new Error("unreachable");
		seeded.conclusion = "failure"; // mutating the input must not leak in
		const summary = await forge.listChecks(ref, "sha-1");
		expect(summary.ok).toBe(true);
		if (summary.ok) {
			expect(summary.value.conclusion).toBe("passing");
			expect(summary.value.runs).toHaveLength(1);
			const returned = summary.value.runs[0];
			if (returned === undefined) throw new Error("unreachable");
			returned.conclusion = "failure"; // nor must mutating the output
			const again = await forge.listChecks(ref, "sha-1");
			if (again.ok) expect(again.value.runs[0]?.conclusion).toBe("success");
		}
	});

	test("fetchJobLogTail synthesizes a deterministic log and tails it", async () => {
		const { forge, ref } = setup();
		const full = await forge.fetchJobLogTail(ref, "job-9", Number.MAX_SAFE_INTEGER);
		expect(full.ok).toBe(true);
		if (full.ok) {
			expect(full.value).toContain("[fake-forge] job job-9 log line 1");
			expect(full.value).toContain("log line 20");
		}
		const tailed = await forge.fetchJobLogTail(ref, "job-9", 40);
		expect(tailed.ok).toBe(true);
		if (tailed.ok) {
			expect(tailed.value?.length).toBeLessThanOrEqual(40);
			expect(tailed.value).toContain("log line 20");
		}
		// The "cannot supply logs" case is ok-null, not an error (contract §1).
		const none = await forge.fetchJobLogTail(ref, "", 100);
		expect(none.ok).toBe(true);
		if (none.ok) expect(none.value).toBeNull();
	});
});

describe("FakeForge branch cleanup", () => {
	test("deleteBranch records the deletion for the acceptance assertion", async () => {
		const { forge, ref } = setup();
		expect(forge.isBranchDeleted(ref, "warren/run-1")).toBe(false);
		const result = await forge.deleteBranch(ref, "warren/run-1");
		expect(result.ok).toBe(true);
		expect(forge.isBranchDeleted(ref, "warren/run-1")).toBe(true);
	});
});

describe("FakeForgeStore", () => {
	test("shares state across FakeForge instances constructed over it", async () => {
		const store = new FakeForgeStore();
		const a = new FakeForge({ store });
		const b = new FakeForge({ store });
		const ref = a.parseRepoRef("fake://p/r");
		if (ref === null) throw new Error("unreachable");
		const opened = await a.openPullRequest(ref, DRAFT);
		if (!opened.ok) throw new Error("unreachable");
		const seen = await b.getPullRequest(ref, opened.value);
		expect(seen.ok).toBe(true);
	});
});

describe("FakeForgeStore state-file seam (warren-2600)", () => {
	test("persists mutations and reloads external edits (the harness's markMerged)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "warren-fake-store-"));
		const stateFile = join(dir, "state.json");
		try {
			const forge = new FakeForge({ store: new FakeForgeStore({ stateFile }) });
			const ref = forge.parseRepoRef("fake://projects/widget");
			if (ref === null) throw new Error("unreachable");
			const opened = await forge.openPullRequest(ref, DRAFT);
			if (!opened.ok) throw new Error("unreachable");
			expect(existsSync(stateFile)).toBe(true);

			// An external writer (the acceptance harness, another process)
			// flips the PR to merged by editing the document.
			const state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeForgeStateFile;
			const record = state.prs["projects/widget"]?.[0];
			if (record === undefined) throw new Error("unreachable");
			record.lifecycle = "merged";
			record.mergedAt = 1_700_000_000_000;
			writeFileSync(stateFile, JSON.stringify(state));

			const polled = await forge.getPullRequest(ref, opened.value);
			expect(polled.ok).toBe(true);
			if (polled.ok) {
				expect(polled.value.lifecycle).toBe("merged");
				expect(polled.value.mergedAt).toBe(1_700_000_000_000);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a torn or missing state file keeps the in-memory state", async () => {
		const dir = await mkdtemp(join(tmpdir(), "warren-fake-store-"));
		const stateFile = join(dir, "state.json");
		try {
			const forge = new FakeForge({ store: new FakeForgeStore({ stateFile }) });
			const ref = forge.parseRepoRef("fake://projects/widget");
			if (ref === null) throw new Error("unreachable");
			const opened = await forge.openPullRequest(ref, DRAFT);
			if (!opened.ok) throw new Error("unreachable");
			writeFileSync(stateFile, "{ not json");
			const polled = await forge.getPullRequest(ref, opened.value);
			expect(polled.ok).toBe(true);
			if (polled.ok) expect(polled.value.lifecycle).toBe("open");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("rollUpChecks", () => {
	const completed = (conclusion: string | null): CheckRun => ({
		name: "n",
		status: "completed",
		conclusion,
		jobId: null,
		detailsUrl: null,
	});

	test("derives the four conclusions", () => {
		expect(rollUpChecks([])).toBe("unknown");
		expect(rollUpChecks([{ ...completed(null), status: "in_progress" }])).toBe("pending");
		expect(rollUpChecks([completed("success"), completed("failure")])).toBe("failing");
		expect(rollUpChecks([completed("cancelled")])).toBe("failing");
		expect(rollUpChecks([completed("success"), completed("skipped"), completed(null)])).toBe(
			"passing",
		);
	});
});

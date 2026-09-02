/**
 * In-pod `collectFinalizeResult` on the ref-dispatch REPAIR topology
 * (warren-ba08, #979 / #994) — parity with
 * `../local/finalize.repair-base.test.ts`. `branch === baseBranch` ⇒ pin the
 * pre-push `origin/<base>` tip, push, then count `<sha>..HEAD`.
 */

import { describe, expect, test } from "bun:test";
import {
	collectFinalizeResult,
	type FinalizeFs,
	type FinalizeGitRunner,
} from "./finalize-collect.ts";
import { IN_POD_FINALIZE_WIRE_VERSION, type InPodFinalizeIntent } from "./finalize-wire.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Empty fs seam — the repair intent merges no trackers. */
const NO_FS: FinalizeFs = {
	readFile: async (path) => {
		throw new Error(`ENOENT ${path}`);
	},
	readdir: async (path) => {
		throw new Error(`ENOTDIR ${path}`);
	},
};

/** Git seam recording argv, returning scripted `{exitCode,stdout,stderr}` by first arg. */
function fakeGit(
	script: Partial<Record<string, { exitCode?: number; stdout?: string; stderr?: string }>> = {},
): { git: FinalizeGitRunner; calls: string[][] } {
	const calls: string[][] = [];
	const git: FinalizeGitRunner = async (args) => {
		calls.push(args);
		const s = script[args[0] ?? ""] ?? {};
		return { exitCode: s.exitCode ?? 0, stdout: s.stdout ?? "", stderr: s.stderr ?? "" };
	};
	return { git, calls };
}

function repairIntent(over: Partial<InPodFinalizeIntent> = {}): InPodFinalizeIntent {
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		attemptId: "fin_abcdefghjkmn",
		branch: "fix/pr-head",
		baseBranch: "fix/pr-head",
		push: true,
		artifacts: [],
		commit: [],
		...over,
	};
}

describe("collectFinalizeResult — ref-dispatch repair topology (warren-ba08)", () => {
	test("pins origin/<base> before the push and counts against the SHA after it", async () => {
		const { git, calls } = fakeGit({
			"rev-parse": { stdout: `${SHA}\n` },
			"rev-list": { stdout: "2" },
		});
		const r = await collectFinalizeResult(repairIntent(), "/ws", { fs: NO_FS, git });
		expect(r.pushed).toBe(true);
		expect(r.commitsAhead).toBe(2);
		expect(r.emptyPush).toBe(false);
		expect(r.prBranch).toBe("fix/pr-head");
		expect(r.commitsAheadBase).toBe(SHA);
		expect(calls).toEqual([
			["rev-parse", "--verify", "origin/fix/pr-head"],
			["push", "origin", "HEAD:fix/pr-head"],
			["rev-list", "--count", "--first-parent", `${SHA}..HEAD`],
		]);
		expect(r.stages).toEqual([
			{ stage: "branch_push", status: "ok" },
			{ stage: "commits_ahead", status: "ok" },
		]);
	});

	test("an unresolvable tracking ref fails commits_ahead to null, never 0", async () => {
		const { git, calls } = fakeGit({
			"rev-parse": { exitCode: 128, stderr: "fatal: Needed a single revision\n" },
			"rev-list": { stdout: "0" },
		});
		const r = await collectFinalizeResult(repairIntent(), "/ws", { fs: NO_FS, git });
		expect(r.pushed).toBe(true);
		expect(r.commitsAhead).toBeNull();
		expect(r.commitsAheadBase).toBeUndefined();
		expect(r.emptyPush).toBe(false);
		expect(r.stages).toEqual([
			{ stage: "branch_push", status: "ok" },
			{ stage: "commits_ahead", status: "failed", error: "fatal: Needed a single revision" },
		]);
		expect(calls.some((c) => c[0] === "rev-list")).toBe(false);
	});

	test("a failed push skips the count even though the base was pinned", async () => {
		const { git, calls } = fakeGit({
			"rev-parse": { stdout: `${SHA}\n` },
			push: { exitCode: 1, stderr: "remote: rejected" },
		});
		const r = await collectFinalizeResult(repairIntent(), "/ws", { fs: NO_FS, git });
		expect(r.pushed).toBe(false);
		expect(r.commitsAhead).toBeNull();
		expect(r.commitsAheadBase).toBeUndefined();
		expect(calls.map((c) => c[0])).toEqual(["rev-parse", "push"]);
	});

	test("a fresh-branch dispatch never rev-parses and reports the base branch", async () => {
		const { git, calls } = fakeGit({ "rev-list": { stdout: "1" } });
		const r = await collectFinalizeResult(
			repairIntent({ branch: "warren/run_x", baseBranch: "main" }),
			"/ws",
			{ fs: NO_FS, git },
		);
		expect(r.commitsAhead).toBe(1);
		expect(r.commitsAheadBase).toBe("main");
		expect(calls.map((c) => c[0])).toEqual(["push", "rev-list"]);
	});

	test("the result round-trips the wire validator with commitsAheadBase intact", async () => {
		const { git } = fakeGit({ "rev-parse": { stdout: `${SHA}\n` }, "rev-list": { stdout: "2" } });
		const r = await collectFinalizeResult(repairIntent(), "/ws", { fs: NO_FS, git });
		const { validateFinalizeResult } = await import("./finalize-wire.ts");
		expect(validateFinalizeResult(JSON.parse(JSON.stringify(r))).commitsAheadBase).toBe(SHA);
	});
});

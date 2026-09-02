/**
 * `LocalProvider.finalize()` on the ref-dispatch REPAIR topology (warren-ba08,
 * #979 / #994). A repair run pushes back onto the branch it was cut from
 * (`branch === baseBranch`), so HEAD is attached to the base and
 * `rev-list --count base..HEAD` is empty by construction — whether the agent
 * landed 0 commits or 10. finalize must pin the pre-push `origin/<base>` tip
 * BEFORE the push (which rewrites the tracking ref) and count `<sha>..HEAD`
 * after it, reporting the SHA as `commitsAheadBase` so the domain's outcome
 * facts diff the same range.
 */

import { describe, expect, test } from "bun:test";
import {
	FAKE_REV_PARSE_SHA,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
} from "../../runs/reap/test-helpers.ts";
import type { FinalizeIntent, RunHandle } from "../contract.ts";

const WS = "/data/sandbox/ws";
const HANDLE: RunHandle = {
	runId: "run_domain0001",
	sandboxId: "bur_aaaaaaaaaaaa",
	providerRunId: "run_zzzzzzzzzzzz",
};

/** A repair-run intent: the push branch IS the base branch; no tracker merges. */
function repairIntent(overrides: Partial<FinalizeIntent> = {}): FinalizeIntent {
	return {
		branch: "fix/pr-head",
		baseBranch: "fix/pr-head",
		push: true,
		artifacts: [],
		...overrides,
	};
}

function finalizeWith(exec: ReturnType<typeof fakeExec>, intent: FinalizeIntent) {
	const client = fakeBurrowClient(makeBurrow({ workspacePath: WS }));
	return client.withFinalizeSeams(fakeFs().fs, exec.exec).finalize(HANDLE, intent);
}

describe("finalize — ref-dispatch repair topology (warren-ba08)", () => {
	test("pins origin/<base> before the push and counts <sha>..HEAD after it", async () => {
		const exec = fakeExec({ revListCount: "2" });
		const result = await finalizeWith(exec, repairIntent());
		expect(result.pushed).toBe(true);
		expect(result.commitsAhead).toBe(2);
		expect(result.emptyPush).toBe(false);
		expect(result.prBranch).toBe("fix/pr-head");
		expect(result.commitsAheadBase).toBe(FAKE_REV_PARSE_SHA);
		expect(exec.calls.map((c) => c.args)).toEqual([
			["rev-parse", "--verify", "origin/fix/pr-head"],
			["push", "origin", "HEAD:fix/pr-head"],
			["rev-list", "--count", "--first-parent", `${FAKE_REV_PARSE_SHA}..HEAD`],
		]);
		// Every rev-parse / rev-list runs in the workspace.
		expect(new Set(exec.calls.map((c) => c.cwd))).toEqual(new Set([WS]));
		// The stage trail keeps its push-then-count order.
		expect(result.stages).toEqual([
			{ stage: "branch_push", status: "ok" },
			{ stage: "commits_ahead", status: "ok" },
		]);
	});

	test("a zero-commit repair run still reads as an empty push and probes dirtiness", async () => {
		const exec = fakeExec({ revListCount: "0", gitStatus: " M src/foo.ts\n" });
		const result = await finalizeWith(exec, repairIntent());
		expect(result.commitsAhead).toBe(0);
		expect(result.emptyPush).toBe(true);
		expect(result.dirty).toBe(true);
		expect(result.dirtyPaths).toEqual(["src/foo.ts"]);
		expect(exec.calls.map((c) => c.args[0])).toEqual(["rev-parse", "push", "rev-list", "status"]);
	});

	test("an unresolvable tracking ref fails commits_ahead to null — never a structural 0", async () => {
		const exec = fakeExec({ revParse: "" });
		const result = await finalizeWith(exec, repairIntent());
		expect(result.pushed).toBe(true);
		expect(result.commitsAhead).toBe(null);
		expect(result.commitsAheadBase).toBeUndefined();
		expect(result.emptyPush).toBe(false);
		expect(result.prBranch).toBe(null);
		expect(result.stages).toEqual([
			{ stage: "branch_push", status: "ok" },
			{ stage: "commits_ahead", status: "failed", error: "fatal: Needed a single revision" },
		]);
		// No rev-list was attempted against the structurally-empty local range.
		expect(exec.calls.some((c) => c.args[0] === "rev-list")).toBe(false);
	});

	test("a failed push skips the count even though the base was pinned", async () => {
		const exec = fakeExec({ failPush: "remote: rejected" });
		const result = await finalizeWith(exec, repairIntent());
		expect(result.pushed).toBe(false);
		expect(result.commitsAhead).toBe(null);
		expect(result.commitsAheadBase).toBeUndefined();
		expect(exec.calls.map((c) => c.args[0])).toEqual(["rev-parse", "push"]);
		expect(result.stages).toEqual([
			{ stage: "branch_push", status: "failed", error: "remote: rejected" },
			{ stage: "commits_ahead", status: "skipped" },
		]);
	});

	test("push:false skips the pin entirely", async () => {
		const exec = fakeExec();
		await finalizeWith(exec, repairIntent({ push: false }));
		expect(exec.calls).toHaveLength(0);
	});

	test("a fresh-branch dispatch never rev-parses — the plain base ref is the count base", async () => {
		const exec = fakeExec({ revListCount: "1" });
		const result = await finalizeWith(
			exec,
			repairIntent({ branch: "warren/run-1", baseBranch: "main" }),
		);
		expect(result.commitsAhead).toBe(1);
		expect(result.commitsAheadBase).toBe("main");
		expect(exec.calls.map((c) => c.args)).toEqual([
			["push", "origin", "HEAD:warren/run-1"],
			["rev-list", "--count", "--first-parent", "main..HEAD"],
		]);
	});
});

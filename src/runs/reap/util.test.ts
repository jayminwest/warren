import { describe, expect, test } from "bun:test";
import {
	BOOKKEEPING_ARTIFACT_PREFIXES,
	HARNESS_STATE_PREFIXES,
	isBookkeepingOnlyDirty,
	parseDirtyPaths,
	repairBaseTrackingRef,
	WARREN_RUNTIME_SCRATCH,
} from "./util.ts";

describe("repairBaseTrackingRef (warren-ba08)", () => {
	test("a ref-dispatch repair run (branch === baseBranch) counts from origin/<base>", () => {
		expect(repairBaseTrackingRef("fix/pr-head", "fix/pr-head")).toBe("origin/fix/pr-head");
	});

	test("a fresh-branch dispatch keeps the plain base ref", () => {
		expect(repairBaseTrackingRef("warren/run-1", "main")).toBeNull();
	});

	test("an empty push branch (HEAD refspec) is never the repair topology", () => {
		expect(repairBaseTrackingRef("", "")).toBeNull();
	});
});

describe("parseDirtyPaths", () => {
	test("parses porcelain status lines into workspace-relative paths", () => {
		const porcelain = " M src/foo.ts\n?? new.ts\nA  .seeds/issues.jsonl\n";
		expect(parseDirtyPaths(porcelain)).toEqual(["src/foo.ts", "new.ts", ".seeds/issues.jsonl"]);
	});

	test("uses the rename destination for `old -> new` lines", () => {
		expect(parseDirtyPaths("R  old/path.ts -> new/path.ts\n")).toEqual(["new/path.ts"]);
	});

	test("empty stdout yields no paths", () => {
		expect(parseDirtyPaths("")).toEqual([]);
		expect(parseDirtyPaths("\n\n")).toEqual([]);
	});
});

describe("isBookkeepingOnlyDirty", () => {
	test("false for an empty tree (clean = classic no-op, not this branch)", () => {
		expect(isBookkeepingOnlyDirty([])).toBe(false);
	});

	test("true when every dirty path is a warren-managed bookkeeping artifact", () => {
		expect(isBookkeepingOnlyDirty([".mulch/expertise/build.jsonl", ".seeds/issues.jsonl"])).toBe(
			true,
		);
	});

	test("false when any dirty path is real uncommitted work", () => {
		expect(isBookkeepingOnlyDirty([".mulch/expertise/build.jsonl", "src/foo.ts"])).toBe(false);
	});

	test("covers each documented bookkeeping prefix", () => {
		for (const prefix of BOOKKEEPING_ARTIFACT_PREFIXES) {
			expect(isBookkeepingOnlyDirty([`${prefix}file`])).toBe(true);
		}
	});

	test("true for harness-owned scratch state (e.g. claude-code settings.local.json)", () => {
		expect(isBookkeepingOnlyDirty([".claude/settings.local.json"])).toBe(true);
	});

	test("true for a mix of bookkeeping and harness-owned scratch paths", () => {
		expect(isBookkeepingOnlyDirty([".seeds/issues.jsonl", ".claude/settings.local.json"])).toBe(
			true,
		);
	});

	test("covers each documented harness-state prefix", () => {
		for (const prefix of HARNESS_STATE_PREFIXES) {
			expect(isBookkeepingOnlyDirty([`${prefix}file`])).toBe(true);
		}
	});

	test("false when harness scratch is mixed with real uncommitted work", () => {
		expect(isBookkeepingOnlyDirty([".claude/settings.local.json", "src/foo.ts"])).toBe(false);
	});

	// warren-8dc8: .claude.json and .gitconfig.burrow were not covered
	test("'.claude.json'.startsWith('.claude/') is false but still classified ignorable (warren-8dc8)", () => {
		expect(".claude.json".startsWith(".claude/")).toBe(false);
		expect(isBookkeepingOnlyDirty([".claude.json"])).toBe(true);
	});

	test("true for .gitconfig.burrow alone (warren-8dc8)", () => {
		expect(isBookkeepingOnlyDirty([".gitconfig.burrow"])).toBe(true);
	});

	test("true for the full observed dirty set from the original report (warren-8dc8)", () => {
		expect(
			isBookkeepingOnlyDirty([
				".gitconfig.burrow",
				".claude.json",
				".claude/.last-cleanup",
				".claude/backups/",
				".claude/policy-limits.json",
				".claude/projects/",
			]),
		).toBe(true);
	});

	test("false when harness scratch and .gitconfig.burrow are mixed with real work (warren-8dc8)", () => {
		expect(isBookkeepingOnlyDirty([".claude.json", ".gitconfig.burrow", "src/foo.ts"])).toBe(false);
	});

	test(".gitconfig.burrow lives in WARREN_RUNTIME_SCRATCH, not HARNESS_STATE_PREFIXES (ownership split)", () => {
		// .gitconfig.burrow is warren-written for every runtime, so it belongs in the
		// warren-owned constant — not in any harness adapter. A pi run with only this
		// dirty path must also reap clean, which only holds when the coverage comes from
		// the runtime-agnostic list.
		expect(WARREN_RUNTIME_SCRATCH.some((p) => ".gitconfig.burrow".startsWith(p))).toBe(true);
		expect(HARNESS_STATE_PREFIXES.some((p) => ".gitconfig.burrow".startsWith(p))).toBe(false);
		expect(isBookkeepingOnlyDirty([".gitconfig.burrow"])).toBe(true);
	});
});

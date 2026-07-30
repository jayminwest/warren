import { describe, expect, test } from "bun:test";
import {
	BOOKKEEPING_ARTIFACT_PREFIXES,
	HARNESS_STATE_PREFIXES,
	isBookkeepingOnlyDirty,
	parseDirtyPaths,
} from "./util.ts";

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
});

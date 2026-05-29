import { describe, expect, test } from "bun:test";
import {
	composeRunBranch,
	DEFAULT_RUN_BRANCH_PREFIX,
	loadRunBranchPrefixFromEnv,
	resolveRunBranchPrefix,
} from "./branch.ts";

describe("loadRunBranchPrefixFromEnv", () => {
	test("returns undefined when WARREN_RUN_BRANCH_PREFIX is unset", () => {
		expect(loadRunBranchPrefixFromEnv({})).toBeUndefined();
	});

	test("returns undefined for an empty / whitespace-only value", () => {
		expect(loadRunBranchPrefixFromEnv({ WARREN_RUN_BRANCH_PREFIX: "" })).toBeUndefined();
		expect(loadRunBranchPrefixFromEnv({ WARREN_RUN_BRANCH_PREFIX: "   " })).toBeUndefined();
	});

	test("returns undefined for invalid characters (does not block spawn)", () => {
		expect(loadRunBranchPrefixFromEnv({ WARREN_RUN_BRANCH_PREFIX: "Warren" })).toBeUndefined();
		expect(loadRunBranchPrefixFromEnv({ WARREN_RUN_BRANCH_PREFIX: "bot/agent" })).toBeUndefined();
		expect(loadRunBranchPrefixFromEnv({ WARREN_RUN_BRANCH_PREFIX: ".warren" })).toBeUndefined();
	});

	test("returns the trimmed prefix for kebab-case values", () => {
		expect(loadRunBranchPrefixFromEnv({ WARREN_RUN_BRANCH_PREFIX: "warren" })).toBe("warren");
		expect(loadRunBranchPrefixFromEnv({ WARREN_RUN_BRANCH_PREFIX: "  agent-1  " })).toBe("agent-1");
		expect(loadRunBranchPrefixFromEnv({ WARREN_RUN_BRANCH_PREFIX: "bot.fix" })).toBe("bot.fix");
	});
});

describe("resolveRunBranchPrefix", () => {
	test("falls back to DEFAULT_RUN_BRANCH_PREFIX when nothing is set", () => {
		expect(resolveRunBranchPrefix({})).toBe(DEFAULT_RUN_BRANCH_PREFIX);
		expect(DEFAULT_RUN_BRANCH_PREFIX).toBe("burrow");
	});

	test("prefers project default over env over built-in", () => {
		expect(
			resolveRunBranchPrefix({
				projectDefault: "project-prefix",
				envDefault: "env-prefix",
			}),
		).toBe("project-prefix");
		expect(resolveRunBranchPrefix({ envDefault: "env-prefix" })).toBe("env-prefix");
	});

	test("treats whitespace-only inputs as not provided", () => {
		expect(resolveRunBranchPrefix({ projectDefault: "   ", envDefault: "env-prefix" })).toBe(
			"env-prefix",
		);
		expect(resolveRunBranchPrefix({ projectDefault: "   ", envDefault: "   " })).toBe(
			DEFAULT_RUN_BRANCH_PREFIX,
		);
	});
});

describe("composeRunBranch", () => {
	test("joins prefix + run id with a single slash", () => {
		expect(composeRunBranch("warren", "run_abc123")).toBe("warren/run_abc123");
	});

	test("returns the targetBranch override when provided (warren-05ea)", () => {
		expect(composeRunBranch("warren", "run_abc123", "fix/existing-pr")).toBe("fix/existing-pr");
	});

	test("falls back to the composed branch for an empty / whitespace targetBranch", () => {
		expect(composeRunBranch("warren", "run_abc123", "")).toBe("warren/run_abc123");
		expect(composeRunBranch("warren", "run_abc123", "   ")).toBe("warren/run_abc123");
	});
});

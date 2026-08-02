import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { isValidBranchRef, normalizeBranchRef, validateTargetBranch } from "./target-branch.ts";

describe("normalizeBranchRef", () => {
	test("strips a refs/heads qualifier and surrounding whitespace", () => {
		expect(normalizeBranchRef("  refs/heads/main ")).toBe("main");
		expect(normalizeBranchRef("fix/pr-head")).toBe("fix/pr-head");
	});
});

describe("isValidBranchRef", () => {
	test("accepts ordinary branch names including nested segments", () => {
		for (const branch of ["main", "fix/pr-head", "user/feat_1.2", "a", "burrow/run_abc123"]) {
			expect(isValidBranchRef(branch)).toBe(true);
		}
	});

	test("rejects names git check-ref-format would reject", () => {
		for (const branch of [
			"",
			"@",
			"has space",
			"tilde~1",
			"caret^",
			"colon:ref",
			"question?",
			"star*",
			"brack[et",
			"back\\slash",
			"dot..dot",
			"at@{brace",
			"/leading",
			"trailing/",
			"double//slash",
			"-leading-dash",
			"trailing.",
			".hidden",
			"nested/.hidden",
			"feature.lock",
			"nested/thing.lock",
			"ctrl\u0007char",
		]) {
			expect(isValidBranchRef(branch)).toBe(false);
		}
	});
});

describe("validateTargetBranch", () => {
	test("returns undefined for an absent or blank target", () => {
		expect(validateTargetBranch(undefined, "main")).toBeUndefined();
		expect(validateTargetBranch("", "main")).toBeUndefined();
		expect(validateTargetBranch("   ", "main")).toBeUndefined();
	});

	test("returns the normalized branch for a valid non-default target", () => {
		expect(validateTargetBranch("fix/pr-head", "main")).toBe("fix/pr-head");
		expect(validateTargetBranch("refs/heads/fix/pr-head", "main")).toBe("fix/pr-head");
	});

	test("refuses a target equal to the project default branch", () => {
		expect(() => validateTargetBranch("main", "main")).toThrow(ValidationError);
		expect(() => validateTargetBranch("refs/heads/main", "main")).toThrow(
			/default branch.*refused/,
		);
		expect(() => validateTargetBranch("main", "refs/heads/main")).toThrow(ValidationError);
	});

	test("refuses a grammar-invalid target", () => {
		expect(() => validateTargetBranch("bad branch", "main")).toThrow(/not a valid git branch name/);
		expect(() => validateTargetBranch("refs/heads/..", "main")).toThrow(ValidationError);
	});

	test("allows a branch that merely shares a prefix with the default branch", () => {
		expect(validateTargetBranch("main-fix", "main")).toBe("main-fix");
		expect(validateTargetBranch("release/main", "main")).toBe("release/main");
	});

	test("validates grammar even when the project default branch is unknown", () => {
		expect(validateTargetBranch("fix/pr-head", undefined)).toBe("fix/pr-head");
		expect(() => validateTargetBranch("bad branch", undefined)).toThrow(ValidationError);
	});
});

import { describe, expect, test } from "bun:test";
import {
	checkRepoCoordinates,
	isValidOwner,
	isValidRefName,
	isValidRepo,
} from "./github-grammar.ts";

describe("isValidOwner", () => {
	test("accepts valid GitHub logins", () => {
		for (const owner of ["a", "warren-run-bot", "openclaw", "OpenClaw", "a1-b2", "x".repeat(39)]) {
			expect(isValidOwner(owner)).toBe(true);
		}
	});

	test("rejects malformed logins", () => {
		for (const owner of ["", "-a", "a-", "a b", "a".repeat(40), "a~b", "bén"]) {
			expect(isValidOwner(owner)).toBe(false);
		}
	});
});

describe("isValidRepo", () => {
	test("accepts valid repository names", () => {
		for (const repo of ["openclaw", "a", "my.repo", "my_repo", "my-repo", "r".repeat(100)]) {
			expect(isValidRepo(repo)).toBe(true);
		}
	});

	test("rejects malformed repository names", () => {
		for (const repo of ["", ".repo", "repo.", "-repo", "repo.git", "re po", "r".repeat(101)]) {
			expect(isValidRepo(repo)).toBe(false);
		}
	});
});

describe("isValidRefName", () => {
	test("accepts valid refnames", () => {
		for (const ref of ["main", "develop", "release/1.2.3", "feat/x-2", "warren/run/abc123"]) {
			expect(isValidRefName(ref)).toBe(true);
		}
	});

	test("rejects git check-ref-format violations", () => {
		const bad = [
			"",
			"-branch",
			".branch",
			"branch/",
			"branch.",
			"branch//x",
			"branch..x",
			"branch@{x",
			"branch.lock",
			"branch/foo.lock",
			"br an ch",
			"br~ch",
			"br^ch",
			"br:ch",
			"br?ch",
			"br*ch",
			"br[ch",
			"br\\ch",
			"x".repeat(256),
		];
		for (const ref of bad) {
			expect(isValidRefName(ref)).toBe(false);
		}
	});
});

describe("checkRepoCoordinates", () => {
	test("returns normalized coordinates for a valid pair", () => {
		expect(checkRepoCoordinates({ owner: "openclaw", repo: "openclaw" })).toEqual({
			owner: "openclaw",
			repo: "openclaw",
		});
	});

	test("returns null for invalid shapes and grammars", () => {
		for (const value of [null, [], "x", { owner: "a" }, { owner: "-a", repo: "b" }, 5]) {
			expect(checkRepoCoordinates(value)).toBeNull();
		}
	});
});

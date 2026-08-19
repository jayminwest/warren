import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { isCommitSha, validateBaseCommit, validateDispatchRef } from "./base-commit.ts";

describe("baseCommit validation (warren-aaf7)", () => {
	test("isCommitSha accepts a full 40-hex SHA and nothing else", () => {
		expect(isCommitSha("a".repeat(40))).toBe(true);
		expect(isCommitSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
		expect(isCommitSha("A".repeat(40))).toBe(true);
		expect(isCommitSha("abc123")).toBe(false); // short id
		expect(isCommitSha("main")).toBe(false);
		expect(isCommitSha(`${"a".repeat(40)}0`)).toBe(false); // 41 chars
		expect(isCommitSha("")).toBe(false);
	});

	test("validateDispatchRef passes a well-formed branch name through", () => {
		expect(validateDispatchRef("fix/pr-head")).toBe("fix/pr-head");
		expect(validateDispatchRef("main")).toBe("main");
	});

	test("validateDispatchRef treats empty/undefined as not supplied", () => {
		expect(validateDispatchRef(undefined)).toBeUndefined();
		expect(validateDispatchRef("")).toBeUndefined();
		expect(validateDispatchRef("   ")).toBeUndefined();
	});

	test("validateDispatchRef rejects a 40-hex SHA with a pointer to baseCommit", () => {
		const sha = "0123456789abcdef0123456789abcdef01234567";
		try {
			validateDispatchRef(sha);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			expect((err as ValidationError).recoveryHint ?? "").toContain("baseCommit");
		}
	});

	test("validateDispatchRef rejects a malformed branch name", () => {
		expect(() => validateDispatchRef("bad..branch")).toThrow(ValidationError);
		expect(() => validateDispatchRef("has space")).toThrow(ValidationError);
		expect(() => validateDispatchRef(".starts-with-dot")).toThrow(ValidationError);
	});

	test("validateBaseCommit passes a full SHA through and rejects everything else", () => {
		expect(validateBaseCommit("0123456789abcdef0123456789abcdef01234567")).toBe(
			"0123456789abcdef0123456789abcdef01234567",
		);
		expect(validateBaseCommit(undefined)).toBeUndefined();
		expect(validateBaseCommit("")).toBeUndefined();
		expect(() => validateBaseCommit("abc123")).toThrow(ValidationError);
		expect(() => validateBaseCommit("main")).toThrow(ValidationError);
		expect(() => validateBaseCommit(`${"a".repeat(40)}0`)).toThrow(ValidationError);
	});
});

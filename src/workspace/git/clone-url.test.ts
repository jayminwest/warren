import { describe, expect, test } from "bun:test";
import { authenticatedCloneUrl } from "./clone-url.ts";

describe("authenticatedCloneUrl", () => {
	test("injects x-access-token for https URLs", () => {
		expect(authenticatedCloneUrl("https://github.com/o/r.git", "tok")).toBe(
			"https://x-access-token:tok@github.com/o/r.git",
		);
	});

	test("leaves the URL alone without a token", () => {
		expect(authenticatedCloneUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
	});

	test("does not touch ssh URLs", () => {
		expect(authenticatedCloneUrl("git@github.com:o/r.git", "tok")).toBe("git@github.com:o/r.git");
	});

	test("does not double-inject when the authority already has userinfo", () => {
		expect(authenticatedCloneUrl("https://user:pw@github.com/o/r.git", "tok")).toBe(
			"https://user:pw@github.com/o/r.git",
		);
	});
});

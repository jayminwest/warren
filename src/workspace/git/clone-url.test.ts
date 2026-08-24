import { describe, expect, test } from "bun:test";
import { authenticatedCloneUrl, bareTokenCredential, DEFAULT_GIT_USERNAME } from "./clone-url.ts";

const github = { username: "x-access-token", secret: "tok" };

describe("authenticatedCloneUrl", () => {
	test("injects the credential's own username for https URLs", () => {
		expect(authenticatedCloneUrl("https://github.com/o/r.git", github)).toBe(
			"https://x-access-token:tok@github.com/o/r.git",
		);
	});

	test("uses the username the forge minted, not a GitHub literal", () => {
		expect(
			authenticatedCloneUrl("https://gitlab.com/o/r.git", { username: "oauth2", secret: "glpat" }),
		).toBe("https://oauth2:glpat@gitlab.com/o/r.git");
		expect(
			authenticatedCloneUrl("https://bitbucket.org/o/r.git", {
				username: "x-token-auth",
				secret: "bb",
			}),
		).toBe("https://x-token-auth:bb@bitbucket.org/o/r.git");
	});

	test("keeps a self-hosted forge's port in the authority", () => {
		expect(
			authenticatedCloneUrl("https://git.acme.internal:8443/o/r.git", {
				username: "oauth2",
				secret: "glpat",
			}),
		).toBe("https://oauth2:glpat@git.acme.internal:8443/o/r.git");
	});

	test("leaves the URL alone without a credential", () => {
		expect(authenticatedCloneUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
	});

	test("leaves the URL alone when the secret is empty", () => {
		expect(
			authenticatedCloneUrl("https://github.com/o/r.git", { username: "oauth2", secret: "" }),
		).toBe("https://github.com/o/r.git");
	});

	test("falls back to the default username when the forge named none", () => {
		expect(
			authenticatedCloneUrl("https://github.com/o/r.git", { username: "", secret: "tok" }),
		).toBe(`https://${DEFAULT_GIT_USERNAME}:tok@github.com/o/r.git`);
	});

	test("does not touch ssh URLs", () => {
		expect(authenticatedCloneUrl("git@github.com:o/r.git", github)).toBe("git@github.com:o/r.git");
	});

	test("does not double-inject when the authority already has userinfo", () => {
		expect(authenticatedCloneUrl("https://user:pw@github.com/o/r.git", github)).toBe(
			"https://user:pw@github.com/o/r.git",
		);
	});
});

describe("bareTokenCredential", () => {
	test("names the GitHub scheme for a token that arrived without a username", () => {
		expect(bareTokenCredential("pod-tok")).toEqual({
			username: DEFAULT_GIT_USERNAME,
			secret: "pod-tok",
		});
	});

	test("is undefined for no token, so the URL stays anonymous", () => {
		expect(bareTokenCredential(undefined)).toBeUndefined();
		expect(bareTokenCredential("")).toBeUndefined();
	});
});

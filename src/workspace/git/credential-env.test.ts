import { describe, expect, test } from "bun:test";
import { gitCredentialGitEnv } from "./credential-env.ts";

describe("gitCredentialGitEnv", () => {
	test("renders the insteadOf rule as GIT_CONFIG_* vars", () => {
		expect(
			gitCredentialGitEnv({ username: "x-access-token", secret: "tok", host: "github.com" }),
		).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://x-access-token:tok@github.com/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://github.com/",
		});
	});

	test("takes the username and the host from the credential, not from a literal", () => {
		// warren-1b6f: both used to be hardcoded here, which made the rewrite a
		// rule only github.com could match.
		expect(
			gitCredentialGitEnv({ username: "oauth2", secret: "glpat-x", host: "gitlab.example.com" }),
		).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://oauth2:glpat-x@gitlab.example.com/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://gitlab.example.com/",
		});
	});

	test("no credential means empty overrides, so a public repo clones anonymously", () => {
		expect(gitCredentialGitEnv(undefined)).toEqual({});
	});

	test("a credential missing any of its three parts renders nothing", () => {
		expect(gitCredentialGitEnv({ username: "oauth2", secret: "", host: "h" })).toEqual({});
		expect(gitCredentialGitEnv({ username: "", secret: "s", host: "h" })).toEqual({});
		expect(gitCredentialGitEnv({ username: "oauth2", secret: "s", host: "" })).toEqual({});
	});
});

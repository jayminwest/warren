import { describe, expect, test } from "bun:test";
import { GITHUB_FORGE_KIND, parseGitHubRepoRef } from "./repo-ref.ts";

describe("parseGitHubRepoRef", () => {
	test("parses the https clone grammar, stripping .git and trailing slashes", () => {
		expect(parseGitHubRepoRef("https://github.com/owner/repo")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
		expect(parseGitHubRepoRef("https://github.com/owner/repo.git")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
		expect(parseGitHubRepoRef("https://github.com/owner/repo.git/")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
	});

	test("parses the scp-style grammar", () => {
		expect(parseGitHubRepoRef("git@github.com:owner/repo")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
		expect(parseGitHubRepoRef("git@github.com:owner/repo.git")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
	});

	test("parses the ssh clone grammar", () => {
		expect(parseGitHubRepoRef("ssh://git@github.com/owner/repo.git")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
	});

	test("parses PR web URLs, tolerating query and fragment", () => {
		expect(parseGitHubRepoRef("https://github.com/owner/repo/pull/7")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
		expect(parseGitHubRepoRef("https://github.com/owner/repo/pull/7?diff=split#files")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
	});

	test("parses REST API URLs", () => {
		expect(parseGitHubRepoRef("https://api.github.com/repos/owner/repo/pulls/7")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
		expect(parseGitHubRepoRef("https://api.github.com/repos/owner/repo")).toEqual({
			forge: "github",
			key: "github.com/owner/repo",
		});
	});

	test("returns null for foreign hosts without throwing", () => {
		expect(parseGitHubRepoRef("https://gitlab.com/owner/repo.git")).toBeNull();
		expect(parseGitHubRepoRef("git@gitlab.com:owner/repo.git")).toBeNull();
		expect(parseGitHubRepoRef("https://ghe.example.com/owner/repo")).toBeNull();
		expect(parseGitHubRepoRef("file:///tmp/repo")).toBeNull();
		expect(parseGitHubRepoRef("fake://projects/widget")).toBeNull();
	});

	test("returns null for malformed input without throwing", () => {
		expect(parseGitHubRepoRef("")).toBeNull();
		expect(parseGitHubRepoRef("   ")).toBeNull();
		expect(parseGitHubRepoRef("not a url")).toBeNull();
		expect(parseGitHubRepoRef("https://github.com/onlyowner")).toBeNull();
		expect(parseGitHubRepoRef("https://github.com/o/r/extra/path")).toBeNull();
		expect(parseGitHubRepoRef("https://api.github.com/repos/o/r/issues/7")).toBeNull();
		expect(parseGitHubRepoRef("https://github.com/o/r/pull/abc")).toBeNull();
	});

	test("the packed key keeps the src/projects/url.ts path-safety validation (mx-e741b0)", () => {
		// Path traversal and off-charset segments must reject, exactly like
		// parseGitHubUrl — the key feeds /data/projects/<owner>/<name>.
		expect(parseGitHubRepoRef("https://github.com/../repo")).toBeNull();
		expect(parseGitHubRepoRef("https://github.com/owner/..")).toBeNull();
		expect(parseGitHubRepoRef("https://github.com/./repo")).toBeNull();
		expect(parseGitHubRepoRef("https://github.com/-flag/repo")).toBeNull();
		expect(parseGitHubRepoRef("https://github.com/owner/repo%2f..")).toBeNull();
		expect(parseGitHubRepoRef("git@github.com:.. /repo")).toBeNull();
		// Legitimate GitHub charset still parses.
		expect(parseGitHubRepoRef("https://github.com/own.er/re_po-1")).toEqual({
			forge: "github",
			key: "github.com/own.er/re_po-1",
		});
	});

	test("exports the registry key", () => {
		expect(GITHUB_FORGE_KIND).toBe("github");
	});
});

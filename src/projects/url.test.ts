import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { GitHubForge } from "../forge/github/provider.ts";
import { parseForgeOwnedUrl, parseGitHubUrl } from "./url.ts";

describe("parseGitHubUrl", () => {
	test("accepts https URLs with and without the .git suffix", () => {
		expect(parseGitHubUrl("https://github.com/jayminwest/warren")).toEqual({
			owner: "jayminwest",
			name: "warren",
		});
		expect(parseGitHubUrl("https://github.com/jayminwest/warren.git")).toEqual({
			owner: "jayminwest",
			name: "warren",
		});
		expect(parseGitHubUrl("https://github.com/jayminwest/warren/")).toEqual({
			owner: "jayminwest",
			name: "warren",
		});
	});

	test("accepts the scp-style git@github.com:owner/name shape", () => {
		expect(parseGitHubUrl("git@github.com:jayminwest/warren.git")).toEqual({
			owner: "jayminwest",
			name: "warren",
		});
		expect(parseGitHubUrl("git@github.com:jayminwest/warren")).toEqual({
			owner: "jayminwest",
			name: "warren",
		});
	});

	test("accepts ssh:// URLs", () => {
		expect(parseGitHubUrl("ssh://git@github.com/jayminwest/warren.git")).toEqual({
			owner: "jayminwest",
			name: "warren",
		});
	});

	test("trims surrounding whitespace before parsing", () => {
		expect(parseGitHubUrl("  https://github.com/jayminwest/warren\n")).toEqual({
			owner: "jayminwest",
			name: "warren",
		});
	});

	test("rejects empty input", () => {
		expect(() => parseGitHubUrl("")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("   ")).toThrow(ValidationError);
	});

	test("rejects non-GitHub hosts", () => {
		expect(() => parseGitHubUrl("https://gitlab.com/owner/name.git")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("git@gitlab.com:owner/name.git")).toThrow(ValidationError);
	});

	test("rejects file:// and other schemes", () => {
		expect(() => parseGitHubUrl("file:///tmp/repo")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("ftp://github.com/owner/name")).toThrow(ValidationError);
	});

	test("rejects URLs missing owner or name", () => {
		expect(() => parseGitHubUrl("https://github.com/")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/jayminwest")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("git@github.com:jayminwest")).toThrow(ValidationError);
	});

	test("rejects path-traversal segments and dash-leading names", () => {
		expect(() => parseGitHubUrl("https://github.com/../escape.git")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/owner/..")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/owner/.")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/-owner/repo")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/owner/-repo")).toThrow(ValidationError);
	});

	test("rejects names with disallowed characters (slashes, spaces, etc.)", () => {
		expect(() => parseGitHubUrl("https://github.com/owner/sub/dir/repo")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/owner/repo name")).toThrow(ValidationError);
	});
});

describe("parseForgeOwnedUrl (warren-2600)", () => {
	test("derives layout segments from a FakeForge-owned fake:// URL", () => {
		expect(parseForgeOwnedUrl("fake://projects/widget", new FakeForge())).toEqual({
			owner: "projects",
			name: "widget",
		});
		expect(parseForgeOwnedUrl("fake://a/b/c", new FakeForge())).toEqual({
			owner: "b",
			name: "c",
		});
	});

	test("returns null for URLs the forge disowns", () => {
		expect(parseForgeOwnedUrl("https://github.com/o/r.git", new FakeForge())).toBeNull();
		expect(
			parseForgeOwnedUrl("fake://projects/widget", new GitHubForge({ token: "t" })),
		).toBeNull();
		expect(parseForgeOwnedUrl("not a url", new FakeForge())).toBeNull();
		expect(parseForgeOwnedUrl("", new FakeForge())).toBeNull();
	});

	test("returns null when the path can't supply two safe segments", () => {
		expect(parseForgeOwnedUrl("fake://onlyone", new FakeForge())).toBeNull();
		expect(parseForgeOwnedUrl("fake://../escape", new FakeForge())).toBeNull();
		expect(parseForgeOwnedUrl("fake://owner/repo name", new FakeForge())).toBeNull();
	});
});

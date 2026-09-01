import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { AdoForge } from "../forge/ado/provider.ts";
import type { Forge } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { GitHubForge } from "../forge/github/provider.ts";
import { assertNoUserinfo, parseForgeOwnedUrl, parseGitHubUrl, parseProjectUrl } from "./url.ts";

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

	test("a forge that names its own layout wins over the last-two-segments rule", () => {
		const ado = new AdoForge({ token: "t" });
		expect(parseForgeOwnedUrl("https://dev.azure.com/org/Proj/_git/repo", ado)).toEqual({
			owner: "org-Proj",
			name: "repo",
		});
		expect(parseForgeOwnedUrl("https://github.com/o/r.git", ado)).toBeNull();
	});

	test("a forge-named layout is still held to the path-safety rule", () => {
		const forge = {
			...new FakeForge(),
			parseRepoRef: () => ({ forge: "x", key: "k" }),
			repoLayout: () => ({ owner: "..", name: "repo" }),
		} as unknown as Forge;
		expect(parseForgeOwnedUrl("x://a/b", forge)).toBeNull();
	});
});

describe("parseProjectUrl", () => {
	test("parses github grammars without a forge", () => {
		expect(parseProjectUrl("https://github.com/o/r.git", undefined)).toEqual({
			owner: "o",
			name: "r",
		});
	});

	test("falls back to the forge-owned layout for a URL github grammar rejects", () => {
		const ado = new AdoForge({ token: "t" });
		expect(parseProjectUrl("https://dev.azure.com/org/Proj/_git/repo", ado)).toEqual({
			owner: "org-Proj",
			name: "repo",
		});
	});

	test("surfaces the original validation error for a URL nobody owns", () => {
		expect(() => parseProjectUrl("https://gitlab.com/o/r.git", new FakeForge())).toThrow(
			/unrecognized GitHub URL/,
		);
	});

	test("tolerates userinfo — registration rejects it, the heal path must still parse the row", () => {
		const ado = new AdoForge({ token: "t" });
		expect(parseProjectUrl("https://org@dev.azure.com/org/Proj/_git/repo", ado)).toEqual({
			owner: "org-Proj",
			name: "repo",
		});
		expect(parseProjectUrl("https://user@github.com/o/r.git", undefined)).toEqual({
			owner: "o",
			name: "r",
		});
	});

	test("lays a punctuated project name out under a sanitized, disambiguated owner", () => {
		const ado = new AdoForge({ token: "t" });
		const url = "https://dev.azure.com/acme/Team%20(EU)/_git/widget";
		expect(parseProjectUrl(url, ado)).toEqual({ owner: "acme-Team-EU-912e3508", name: "widget" });
	});

	test("leaves the ssh user alone — it is not a credential", () => {
		expect(parseProjectUrl("ssh://git@github.com/o/r.git", undefined)).toEqual({
			owner: "o",
			name: "r",
		});
	});
});

describe("assertNoUserinfo", () => {
	test("refuses https URLs carrying a username or credentials", () => {
		expect(() => assertNoUserinfo("https://org@dev.azure.com/org/Proj/_git/repo")).toThrow(
			/must not carry credentials or a username/,
		);
		expect(() => assertNoUserinfo("https://x:secret@github.com/o/r.git")).toThrow(
			/must not carry credentials/,
		);
	});

	test("leaves the ssh user and clean URLs alone", () => {
		expect(() => assertNoUserinfo("ssh://git@github.com/o/r.git")).not.toThrow();
		expect(() => assertNoUserinfo("https://github.com/o/r.git")).not.toThrow();
		expect(() => assertNoUserinfo("not a url")).not.toThrow();
	});
});

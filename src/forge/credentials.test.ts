import { describe, expect, test } from "bun:test";
import { GitCredentialMintError, mintGitCredential } from "./credentials.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import { GitHubForge } from "./github/provider.ts";

describe("mintGitCredential", () => {
	test("returns undefined for a URL the forge does not own", async () => {
		const forge = new GitHubForge({ token: "tok" });
		expect(await mintGitCredential(forge, "https://gitlab.com/x/y.git")).toBeUndefined();
	});

	test("mints the static secret for an owned URL under PAT mode", async () => {
		const forge = new GitHubForge({ token: "tok" });
		expect(await mintGitCredential(forge, "https://github.com/x/y.git")).toEqual({
			username: "x-access-token",
			secret: "tok",
			host: "github.com",
		});
	});

	test("maps no_credential (empty token) to anonymous git", async () => {
		const forge = new GitHubForge({ token: "" });
		expect(await mintGitCredential(forge, "https://github.com/x/y.git")).toBeUndefined();
	});

	test("mints the FakeForge credential, with no host to rewrite against", async () => {
		// FakeForge OWNS fake://repo, but its authority is the repo name rather
		// than a git host, so there is no https remote an insteadOf rule could
		// name. The credential still exists for the consumers that do not need
		// one; only the rewrite renders nothing (warren-1b6f).
		const forge = new FakeForge();
		expect(await mintGitCredential(forge, "fake://repo")).toEqual({
			username: "fake",
			secret: "fake-credential",
			host: "",
		});
	});

	test("reads the host off the clone URL, in each spelling warren accepts", async () => {
		const forge = new GitHubForge({ token: "tok" });
		for (const url of [
			"https://github.com/x/y.git",
			"ssh://git@github.com/x/y.git",
			"git@github.com:x/y.git",
		]) {
			expect((await mintGitCredential(forge, url))?.host, url).toBe("github.com");
		}
	});

	test("keeps a self-hosted forge port in the host it rewrites against", async () => {
		// git treats host and host:port as different remotes, so an insteadOf
		// rule that drops the port names a URL that never appears.
		const forge = new GitHubForge({ token: "tok" });
		forge.parseRepoRef = (url: string) =>
			url.includes("acme.internal") ? { forge: "github", key: "x/y" } : null;
		for (const url of [
			"https://git.acme.internal:8443/x/y.git",
			"ssh://git@git.acme.internal:2222/x/y.git",
		]) {
			expect((await mintGitCredential(forge, url))?.host, url).toBe(
				url.startsWith("https") ? "git.acme.internal:8443" : "git.acme.internal:2222",
			);
		}
	});

	test("throws GitCredentialMintError on a non-no_credential mint failure", async () => {
		const forge = new GitHubForge({ token: "tok" });
		forge.gitCredential = () =>
			Promise.resolve({
				ok: false,
				error: { kind: "network", detail: "boom" },
			});
		await expect(mintGitCredential(forge, "https://github.com/x/y.git")).rejects.toBeInstanceOf(
			GitCredentialMintError,
		);
	});
});

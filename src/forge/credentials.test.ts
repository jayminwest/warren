import { describe, expect, test } from "bun:test";
import { GitCredentialMintError, mintGitCredentialSecret } from "./credentials.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import { GitHubForge } from "./github/provider.ts";

describe("mintGitCredentialSecret", () => {
	test("returns undefined for a URL the forge does not own", async () => {
		const forge = new GitHubForge({ token: "tok" });
		expect(await mintGitCredentialSecret(forge, "https://gitlab.com/x/y.git")).toBeUndefined();
	});

	test("mints the static secret for an owned URL under PAT mode", async () => {
		const forge = new GitHubForge({ token: "tok" });
		expect(await mintGitCredentialSecret(forge, "https://github.com/x/y.git")).toBe("tok");
	});

	test("maps no_credential (empty token) to anonymous git", async () => {
		const forge = new GitHubForge({ token: "" });
		expect(await mintGitCredentialSecret(forge, "https://github.com/x/y.git")).toBeUndefined();
	});

	test("mints the FakeForge credential for a fake URL", async () => {
		const forge = new FakeForge();
		expect(await mintGitCredentialSecret(forge, "fake://repo")).toBe("fake-credential");
	});

	test("throws GitCredentialMintError on a non-no_credential mint failure", async () => {
		const forge = new GitHubForge({ token: "tok" });
		forge.gitCredential = () =>
			Promise.resolve({
				ok: false,
				error: { kind: "network", detail: "boom" },
			});
		await expect(
			mintGitCredentialSecret(forge, "https://github.com/x/y.git"),
		).rejects.toBeInstanceOf(GitCredentialMintError);
	});
});

import { describe, expect, test } from "bun:test";
import { ForgeConfigError } from "../errors.ts";
import { jsonResponse, recordingFetch } from "../github/test-helpers.ts";
import {
	GITHUB_APP_ID_ENV,
	GITHUB_APP_INSTALLATION_ID_ENV,
	GITHUB_APP_PRIVATE_KEY_ENV,
	GitHubAppForge,
	loadGitHubAppCredentialsFromEnv,
} from "./provider.ts";
import { generateTestAppKeyPair, stubGitHubAppServer } from "./test-helpers.ts";

function makeForge(overrides: Partial<ConstructorParameters<typeof GitHubAppForge>[0]> = {}) {
	const { privateKeyPem } = generateTestAppKeyPair();
	const forge = new GitHubAppForge({
		appId: "4560297",
		installationId: "555",
		privateKey: privateKeyPem,
		fetch: stubGitHubAppServer().fetch,
		...overrides,
	});
	return forge;
}

const CLONE_URL = "https://github.com/octo/widget.git";

describe("loadGitHubAppCredentialsFromEnv", () => {
	test("reads the WARREN_GITHUB_APP_* triple", () => {
		const creds = loadGitHubAppCredentialsFromEnv({
			[GITHUB_APP_ID_ENV]: "1",
			[GITHUB_APP_INSTALLATION_ID_ENV]: "2",
			[GITHUB_APP_PRIVATE_KEY_ENV]: "pem",
		});
		expect(creds).toEqual({ appId: "1", installationId: "2", privateKey: "pem" });
	});

	test("fails loud listing every missing variable", () => {
		try {
			loadGitHubAppCredentialsFromEnv({});
			throw new Error("unreachable");
		} catch (e) {
			expect(e).toBeInstanceOf(ForgeConfigError);
			const err = e as ForgeConfigError;
			expect(err.code).toBe("forge_config_invalid");
			for (const name of [
				GITHUB_APP_ID_ENV,
				GITHUB_APP_INSTALLATION_ID_ENV,
				GITHUB_APP_PRIVATE_KEY_ENV,
			]) {
				expect(err.message).toContain(name);
			}
			expect(err.recoveryHint).toContain(GITHUB_APP_PRIVATE_KEY_ENV);
		}
	});

	test("treats blank values as missing", () => {
		expect(() =>
			loadGitHubAppCredentialsFromEnv({
				[GITHUB_APP_ID_ENV]: "  ",
				[GITHUB_APP_INSTALLATION_ID_ENV]: "2",
				[GITHUB_APP_PRIVATE_KEY_ENV]: "pem",
			}),
		).toThrow(ForgeConfigError);
	});
});

describe("GitHubAppForge construction", () => {
	test("throws ForgeConfigError on an unparseable private key (boot fails loud)", () => {
		expect(
			() =>
				new GitHubAppForge({
					appId: "1",
					installationId: "2",
					privateKey: "not a pem",
				}),
		).toThrow(ForgeConfigError);
	});
});

describe("GitHubAppForge capabilities (forge-contract.md §5)", () => {
	test("declares the App-mode flags: full Checks access, bot identity, short-lived credentials", () => {
		expect(makeForge().capabilities).toEqual({
			checkRuns: true,
			jobLogs: true,
			pullRequestBodyEdit: true,
			branchDelete: true,
			botIdentity: true,
			installationRepos: true,
			credentialLifetime: "short-lived",
		});
	});
});

describe("GitHubAppForge credential minting", () => {
	test("gitCredential mints an installation token carrying a real expiry", async () => {
		const ref = makeForge().parseRepoRef(CLONE_URL);
		if (ref === null) throw new Error("unreachable");
		const result = await makeForge().gitCredential(ref);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.username).toBe("x-access-token");
		expect(result.value.secret).toBe("ghs_stub_installation_token");
		expect(typeof result.value.expiresAt).toBe("number");
	});

	test("one installation-token mint serves both gitCredential and the API methods", async () => {
		const mints = { count: 0 };
		const forge = makeForge({ fetch: stubGitHubAppServer({ mints }).fetch });
		const ref = forge.parseRepoRef(CLONE_URL);
		if (ref === null) throw new Error("unreachable");
		const cred = await forge.gitCredential(ref);
		expect(cred.ok).toBe(true);
		const opened = await forge.openPullRequest(ref, {
			title: "t",
			body: "b",
			headBranch: "warren/run-1",
			baseBranch: "main",
		});
		expect(opened.ok).toBe(true);
		expect(mints.count).toBe(1);
	});
});

describe("GitHubAppForge delegated surface", () => {
	test("openPullRequest / findPullRequest / getPullRequest ride the shared transport", async () => {
		const forge = makeForge();
		const ref = forge.parseRepoRef(CLONE_URL);
		if (ref === null) throw new Error("unreachable");
		const draft = {
			title: "Add the widget",
			body: "Body.",
			headBranch: "warren/run-1",
			baseBranch: "main",
		};
		const opened = await forge.openPullRequest(ref, draft);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.value.forge).toBe("github");
		const found = await forge.findPullRequest(ref, {
			headBranch: draft.headBranch,
			baseBranch: draft.baseBranch,
		});
		expect(found.ok && found.value?.number === opened.value.number).toBe(true);
		const state = await forge.getPullRequest(ref, opened.value);
		expect(state.ok && state.value.lifecycle === "open").toBe(true);
		const edited = await forge.setPullRequestBody(ref, opened.value, "Rewritten.");
		expect(edited.ok).toBe(true);
	});

	test("listChecks and fetchJobLogTail ride the shared transport", async () => {
		const forge = makeForge();
		const ref = forge.parseRepoRef(CLONE_URL);
		if (ref === null) throw new Error("unreachable");
		const checks = await forge.listChecks(ref, "sha-empty");
		expect(checks.ok && checks.value.conclusion === "unknown").toBe(true);
		const log = await forge.fetchJobLogTail(ref, "job-7", 64);
		expect(log.ok && log.value !== null && log.value.length <= 64).toBe(true);
	});

	test("deleteBranch rides the shared transport", async () => {
		const forge = makeForge();
		const ref = forge.parseRepoRef(CLONE_URL);
		if (ref === null) throw new Error("unreachable");
		expect((await forge.deleteBranch(ref, "warren/run-1")).ok).toBe(true);
	});
});

describe("GitHubAppForge probeCredential (warren-1295 heartbeat seam)", () => {
	test("force-mints and reports ONLY the expiry — the secret never crosses the seam", async () => {
		const mints = { count: 0 };
		const forge = makeForge({ fetch: stubGitHubAppServer({ mints }).fetch });
		const result = await forge.probeCredential();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(typeof result.value.expiresAt).toBe("number");
		expect(JSON.stringify(result.value)).not.toContain("ghs_");
		expect(mints.count).toBe(1);
	});

	test("bypasses the token cache — every probe is a fresh liveness proof", async () => {
		const mints = { count: 0 };
		const forge = makeForge({ fetch: stubGitHubAppServer({ mints }).fetch });
		await forge.probeCredential();
		await forge.probeCredential();
		expect(mints.count).toBe(2);
	});

	test("maps a dead credential (401 on the mint) to unauthorized without throwing", async () => {
		const forge = makeForge({
			fetch: recordingFetch([jsonResponse(401, { message: "Bad credentials" })]).fetch,
		});
		const result = await forge.probeCredential();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unauthorized");
	});
});

describe("GitHubAppForge botIdentity", () => {
	test("names the App's bot from the GET /app slug, cached across calls", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(200, { slug: "warren-ci" }),
			jsonResponse(200, { slug: "warren-ci" }),
		]);
		const forge = makeForge({ fetch });
		const first = await forge.botIdentity();
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.name).toBe("warren-ci[bot]");
		expect(first.value.email).toBe("warren-ci[bot]@users.noreply.github.com");
		const second = await forge.botIdentity();
		expect(second.ok).toBe(true);
		// The second call is a cache hit — recordingFetch would throw past its
		// canned list, so reaching this line proves the cache.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.github.com/app");
	});

	test("maps a GET /app transport failure through the shared classifier", async () => {
		const forge = makeForge({
			fetch: recordingFetch([jsonResponse(401, { message: "Bad credentials" })]).fetch,
		});
		const result = await forge.botIdentity();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unauthorized");
	});

	test("maps a slug-less GET /app body to http_error", async () => {
		const forge = makeForge({ fetch: recordingFetch([jsonResponse(200, {})]).fetch });
		const result = await forge.botIdentity();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("http_error");
	});
});

describe("GitHubAppForge listInstallationRepos (warren-2601)", () => {
	test("returns the installation's repositories as picker rows", async () => {
		const forge = makeForge({
			fetch: stubGitHubAppServer({
				installationRepos: [{ owner: "octo", name: "widget", defaultBranch: "trunk" }],
			}).fetch,
		});
		const result = await forge.listInstallationRepos();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual([
			{
				owner: "octo",
				name: "widget",
				cloneUrl: "https://github.com/octo/widget.git",
				defaultBranch: "trunk",
				private: false,
			},
		]);
	});

	test("paginates with per_page=100 until a short page", async () => {
		const repos = Array.from({ length: 101 }, (_, i) => ({ owner: "octo", name: `r${i}` }));
		const forge = makeForge({
			fetch: stubGitHubAppServer({ installationRepos: repos }).fetch,
		});
		const result = await forge.listInstallationRepos();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.length).toBe(101);
	});

	test("maps a transport failure through the shared classifier", async () => {
		const forge = makeForge({
			fetch: recordingFetch([jsonResponse(403, { message: "Just no" })]).fetch,
		});
		const result = await forge.listInstallationRepos();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("forbidden");
	});
});

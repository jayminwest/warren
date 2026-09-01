import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdoForge } from "./ado/provider.ts";
import type { Forge } from "./contract.ts";
import { ForgeConfigError, UnknownForgeError } from "./errors.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import { FakeForgeStore } from "./fake/store.ts";
import { GitHubForge } from "./github/provider.ts";
import { type GitHubAppCredentials, GitHubAppForge } from "./github-app/provider.ts";
import { generateTestAppKeyPair } from "./github-app/test-helpers.ts";
import {
	DEFAULT_FORGE_KIND,
	FORGE_KINDS,
	type ForgeDeps,
	resolveForge,
	resolveForgeKind,
} from "./registry.ts";

/**
 * Hermetic deps, modeled on `src/runtime/registry.test.ts`: each arm's
 * factory throws if invoked, so a resolution that constructs the WRONG arm
 * fails loudly. The github arm's token factory is supplied per-test with a
 * non-throwing stub; this bag is the baseline for the fake arm.
 */
const fakeArmDeps: ForgeDeps = {
	githubToken: (): string => {
		throw new Error("githubToken factory must not be called when WARREN_FORGE=fake");
	},
};

const githubArmDeps: ForgeDeps = {
	githubToken: () => "test-token",
	githubFetch: (() => {
		throw new Error("github fetch must not be called at construction time");
	}) as unknown as typeof fetch,
	fakeStore: (): FakeForgeStore => {
		throw new Error("fakeStore factory must not be called when WARREN_FORGE=github");
	},
};

describe("resolveForgeKind", () => {
	test("defaults to github when WARREN_FORGE is unset", () => {
		expect(resolveForgeKind({})).toBe("github");
		expect(DEFAULT_FORGE_KIND).toBe("github");
	});

	test("treats a blank / whitespace value as unset (default github)", () => {
		expect(resolveForgeKind({ WARREN_FORGE: "" })).toBe("github");
		expect(resolveForgeKind({ WARREN_FORGE: "   " })).toBe("github");
	});

	test("accepts all registered kinds", () => {
		expect(FORGE_KINDS).toEqual(["github", "app", "ado", "fake"]);
		expect(resolveForgeKind({ WARREN_FORGE: "github" })).toBe("github");
		expect(resolveForgeKind({ WARREN_FORGE: "app" })).toBe("app");
		expect(resolveForgeKind({ WARREN_FORGE: "ado" })).toBe("ado");
		expect(resolveForgeKind({ WARREN_FORGE: "fake" })).toBe("fake");
	});

	test("fails loudly on an unknown value rather than falling back", () => {
		expect(() => resolveForgeKind({ WARREN_FORGE: "gitlab" })).toThrow(UnknownForgeError);
	});

	test("the unknown-kind error lists the legal values in its recoveryHint", () => {
		try {
			resolveForgeKind({ WARREN_FORGE: "gitlab" });
			throw new Error("unreachable");
		} catch (e) {
			expect(e).toBeInstanceOf(UnknownForgeError);
			const hint = (e as UnknownForgeError).recoveryHint ?? "";
			expect(hint).toContain("github");
			expect(hint).toContain("fake");
			expect(hint).toContain('leave it unset for "github"');
		}
	});
});

describe("resolveForge", () => {
	test("resolves GitHubForge by default", () => {
		const forge = resolveForge(githubArmDeps, {});
		expect(forge).toBeInstanceOf(GitHubForge);
	});

	test("resolves GitHubForge for explicit WARREN_FORGE=github", () => {
		expect(resolveForge(githubArmDeps, { WARREN_FORGE: "github" })).toBeInstanceOf(GitHubForge);
	});

	test("resolves FakeForge for WARREN_FORGE=fake", () => {
		expect(resolveForge(fakeArmDeps, { WARREN_FORGE: "fake" })).toBeInstanceOf(FakeForge);
	});

	test("constructs only the selected arm — the fake arm never touches github inputs", () => {
		// fakeArmDeps.githubToken throws if invoked; a successful fake
		// resolution proves the registry did not construct the github arm.
		expect(() => resolveForge(fakeArmDeps, { WARREN_FORGE: "fake" })).not.toThrow();
	});

	test("constructs only the selected arm — the github arm never builds the fake store", () => {
		expect(() => resolveForge(githubArmDeps, { WARREN_FORGE: "github" })).not.toThrow();
	});

	test("WARREN_FAKE_FORGE_STATE_FILE backs the fake store with the file (warren-2600)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "warren-forge-registry-"));
		const stateFile = join(dir, "state.json");
		const forge = resolveForge(fakeArmDeps, {
			WARREN_FORGE: "fake",
			WARREN_FAKE_FORGE_STATE_FILE: stateFile,
		});
		const ref = forge.parseRepoRef("fake://p/r");
		if (ref === null) throw new Error("unreachable");
		const opened = await forge.openPullRequest(ref, {
			title: "t",
			body: "b",
			headBranch: "warren/run-1",
			baseBranch: "main",
		});
		expect(opened.ok).toBe(true);
		const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
			prs: Record<string, { lifecycle: string }[]>;
		};
		expect(persisted.prs["p/r"]?.[0]?.lifecycle).toBe("open");
		await rm(dir, { recursive: true, force: true });
	});

	test("an injected fakeStore factory beats WARREN_FAKE_FORGE_STATE_FILE", () => {
		const store = new FakeForgeStore();
		const forge = resolveForge(
			{ ...fakeArmDeps, fakeStore: () => store },
			{ WARREN_FORGE: "fake", WARREN_FAKE_FORGE_STATE_FILE: "/nonexistent/state.json" },
		);
		expect((forge as FakeForge).store).toBe(store);
	});

	test("the default github token factory reads GITHUB_TOKEN from the selection env", async () => {
		const forge: Forge = resolveForge({}, { GITHUB_TOKEN: "env-token" });
		expect(forge).toBeInstanceOf(GitHubForge);
		const ref = forge.parseRepoRef("https://github.com/o/r.git");
		expect(ref).not.toBeNull();
		if (ref === null) return;
		const credential = await forge.gitCredential(ref);
		expect(credential.ok).toBe(true);
		if (credential.ok) {
			expect(credential.value.secret).toBe("env-token");
			expect(credential.value.expiresAt).toBeNull();
		}
	});

	test("an unset github token constructs the forge; methods degrade to no_credential", async () => {
		const forge = resolveForge({}, {});
		expect(forge).toBeInstanceOf(GitHubForge);
		const ref = forge.parseRepoRef("https://github.com/o/r.git");
		if (ref === null) throw new Error("unreachable");
		const credential = await forge.gitCredential(ref);
		expect(credential.ok).toBe(false);
		if (!credential.ok) expect(credential.error.kind).toBe("no_credential");
	});

	test("threads the githubCheckRuns override onto the github arm", () => {
		const forge = resolveForge({ ...githubArmDeps, githubCheckRuns: false }, {});
		expect(forge.capabilities.checkRuns).toBe(false);
		expect(resolveForge(githubArmDeps, {}).capabilities.checkRuns).toBe(true);
	});

	test("threads an injected fake store onto the fake arm", () => {
		const store = new FakeForge().store;
		const forge = resolveForge({ fakeStore: () => store }, { WARREN_FORGE: "fake" });
		expect((forge as FakeForge).store).toBe(store);
	});

	test("garbage selector throws UnknownForgeError", () => {
		expect(() => resolveForge(githubArmDeps, { WARREN_FORGE: "bitbucket" })).toThrow(
			UnknownForgeError,
		);
	});
});

describe("resolveForge app arm (warren-f8df)", () => {
	const { privateKeyPem } = generateTestAppKeyPair();
	const appCreds = { appId: "1", installationId: "2", privateKey: privateKeyPem };
	const appArmDeps: ForgeDeps = {
		githubToken: (): string => {
			throw new Error("githubToken factory must not be called when WARREN_FORGE=app");
		},
		fakeStore: (): FakeForgeStore => {
			throw new Error("fakeStore factory must not be called when WARREN_FORGE=app");
		},
		githubApp: () => appCreds,
	};

	test("resolves GitHubAppForge for WARREN_FORGE=app from the injected factory", () => {
		const forge = resolveForge(appArmDeps, { WARREN_FORGE: "app" });
		expect(forge).toBeInstanceOf(GitHubAppForge);
		expect(forge.capabilities.credentialLifetime).toBe("short-lived");
	});

	test("constructs only the app arm — the github and fake factories are never touched", () => {
		expect(() => resolveForge(appArmDeps, { WARREN_FORGE: "app" })).not.toThrow();
	});

	test("the default app factory reads the WARREN_GITHUB_APP_* triple from the selection env", () => {
		const forge = resolveForge(
			{ githubAppFetch: (() => {}) as unknown as typeof fetch },
			{
				WARREN_FORGE: "app",
				WARREN_GITHUB_APP_ID: "1",
				WARREN_GITHUB_APP_INSTALLATION_ID: "2",
				WARREN_GITHUB_APP_PRIVATE_KEY: privateKeyPem,
			},
		);
		expect(forge).toBeInstanceOf(GitHubAppForge);
	});

	test("missing app env fails loud at boot with ForgeConfigError", () => {
		expect(() => resolveForge({}, { WARREN_FORGE: "app" })).toThrow(ForgeConfigError);
	});

	test("an unparseable app private key fails loud at boot with ForgeConfigError", () => {
		expect(() =>
			resolveForge(
				{ githubApp: () => ({ appId: "1", installationId: "2", privateKey: "junk" }) },
				{ WARREN_FORGE: "app" },
			),
		).toThrow(ForgeConfigError);
	});

	test("the github and fake arms never touch the app arm's inputs", () => {
		const appFactory = (): GitHubAppCredentials => {
			throw new Error("githubApp factory must not be called for non-app arms");
		};
		expect(() =>
			resolveForge({ ...githubArmDeps, githubApp: appFactory }, { WARREN_FORGE: "github" }),
		).not.toThrow();
		expect(() =>
			resolveForge({ ...fakeArmDeps, githubApp: appFactory }, { WARREN_FORGE: "fake" }),
		).not.toThrow();
	});
});

describe("resolveForge ado arm", () => {
	const adoArmDeps: ForgeDeps = {
		githubToken: (): string => {
			throw new Error("githubToken factory must not be called when WARREN_FORGE=ado");
		},
		githubApp: (): GitHubAppCredentials => {
			throw new Error("githubApp factory must not be called when WARREN_FORGE=ado");
		},
		fakeStore: (): FakeForgeStore => {
			throw new Error("fakeStore factory must not be called when WARREN_FORGE=ado");
		},
		adoToken: () => "ado-pat",
	};

	test("resolves AdoForge for WARREN_FORGE=ado from the injected factory", () => {
		const forge = resolveForge(adoArmDeps, { WARREN_FORGE: "ado" });
		expect(forge).toBeInstanceOf(AdoForge);
		expect(forge.capabilities.credentialLifetime).toBe("static");
		expect(forge.capabilities.checkRuns).toBe(true);
	});

	test("constructs only the ado arm — the github, app and fake factories are never touched", () => {
		expect(() => resolveForge(adoArmDeps, { WARREN_FORGE: "ado" })).not.toThrow();
	});

	test("the default ado token factory reads WARREN_GIT_TOKEN from the selection env", async () => {
		const forge = resolveForge({}, { WARREN_FORGE: "ado", WARREN_GIT_TOKEN: "env-pat" });
		expect(forge).toBeInstanceOf(AdoForge);
		const ref = forge.parseRepoRef("https://dev.azure.com/org/proj/_git/repo");
		if (ref === null) throw new Error("unreachable");
		const credential = await forge.gitCredential(ref);
		expect(credential.ok).toBe(true);
		if (credential.ok) {
			expect(credential.value.secret).toBe("env-pat");
			expect(credential.value.expiresAt).toBeNull();
		}
	});

	test("GITHUB_TOKEN never feeds the ado arm", async () => {
		const forge = resolveForge({}, { WARREN_FORGE: "ado", GITHUB_TOKEN: "gh-token" });
		const ref = forge.parseRepoRef("https://dev.azure.com/org/proj/_git/repo");
		if (ref === null) throw new Error("unreachable");
		const credential = await forge.gitCredential(ref);
		expect(credential.ok).toBe(false);
		if (!credential.ok) expect(credential.error.kind).toBe("no_credential");
	});

	test("the other arms never touch the ado arm's inputs", () => {
		const throwingAdo: ForgeDeps = {
			...githubArmDeps,
			adoToken: (): string => {
				throw new Error("adoToken factory must not be called for other arms");
			},
		};
		expect(() => resolveForge(throwingAdo, { WARREN_FORGE: "github" })).not.toThrow();
		expect(() =>
			resolveForge(
				{ ...throwingAdo, githubToken: undefined, fakeStore: undefined },
				{ WARREN_FORGE: "fake" },
			),
		).not.toThrow();
	});
});

describe("the github arm's static secret", () => {
	test("reads WARREN_GIT_TOKEN before GITHUB_TOKEN", async () => {
		const forge = resolveForge({}, { WARREN_GIT_TOKEN: "neutral", GITHUB_TOKEN: "legacy" });
		const ref = forge.parseRepoRef("https://github.com/x/y.git");
		expect(ref).not.toBeNull();
		const cred = await forge.gitCredential(ref as NonNullable<typeof ref>);
		expect(cred.ok && cred.value.secret).toBe("neutral");
	});

	test("treats an empty or blank neutral token as unset, not as a choice", async () => {
		for (const blank of ["", "   "]) {
			const forge = resolveForge({}, { WARREN_GIT_TOKEN: blank, GITHUB_TOKEN: "legacy" });
			const ref = forge.parseRepoRef("https://github.com/x/y.git");
			const cred = await forge.gitCredential(ref as NonNullable<typeof ref>);
			expect(cred.ok && cred.value.secret, JSON.stringify(blank)).toBe("legacy");
		}
	});

	test("still falls back to GITHUB_TOKEN, so an existing deployment is untouched", async () => {
		const forge = resolveForge({}, { GITHUB_TOKEN: "legacy" });
		const ref = forge.parseRepoRef("https://github.com/x/y.git");
		const cred = await forge.gitCredential(ref as NonNullable<typeof ref>);
		expect(cred.ok && cred.value.secret).toBe("legacy");
	});
});

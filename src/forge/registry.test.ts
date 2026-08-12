import { describe, expect, test } from "bun:test";
import type { Forge } from "./contract.ts";
import { UnknownForgeError } from "./errors.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import type { FakeForgeStore } from "./fake/store.ts";
import { GitHubForge } from "./github/provider.ts";
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

	test("accepts both registered kinds", () => {
		expect(FORGE_KINDS).toEqual(["github", "fake"]);
		expect(resolveForgeKind({ WARREN_FORGE: "github" })).toBe("github");
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

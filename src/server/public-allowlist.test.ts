/**
 * Public-instance org allowlist (warren-ce9b / pl-b82d step 17).
 *
 * The gate is only worth anything if it fails CLOSED, so that is what most
 * of this file pins: public mode with no allowlist refuses, an unparseable
 * `gitUrl` counts as not-allowlisted, and token mode is untouched in every
 * direction. The over-the-wire half (`POST /projects` → 400, nothing
 * cloned) lives in `handlers/projects.public-allowlist.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	assertGitUrlAllowlisted,
	assertRegisteredProjectsAllowlisted,
	WARREN_PUBLIC_ALLOWLIST_ENV as ENV,
	isRepoAllowlisted,
	loadPublicAllowlistFromEnv,
	type PublicAllowlist,
	PublicAllowlistError,
	resolvePublicAllowlist,
} from "./public-allowlist.ts";

const ALLOWED: PublicAllowlist = {
	owners: new Set(["os-eco", "some-owner"]),
	repos: new Set<string>(),
};

/** Repo-granular list: one repo under an owner that is NOT wholly allowed. */
const REPO_SCOPED: PublicAllowlist = {
	owners: new Set<string>(),
	repos: new Set(["some-owner/public-repo", "some-owner/other-public-repo"]),
};

/** Quiet the deprecation notice when a test exercises the legacy env name. */
const silent = () => {};

describe("loadPublicAllowlistFromEnv", () => {
	test("parses a comma-separated list, trimming and lowercasing", () => {
		const allowlist = loadPublicAllowlistFromEnv({ [ENV]: " my-org , OtherOrg " });
		expect([...allowlist.owners].sort()).toEqual(["my-org", "otherorg"]);
	});

	test("a single owner is a valid list", () => {
		expect([...loadPublicAllowlistFromEnv({ [ENV]: "os-eco" }).owners]).toEqual(["os-eco"]);
	});

	// The fail-closed core: an absent or empty list must never widen to
	// "every org". Reverting the length check makes all four of these pass.
	test("absent, blank, or all-empty-entry values refuse", () => {
		for (const raw of [undefined, "", "   ", ",", " , , "]) {
			expect(() => loadPublicAllowlistFromEnv(raw === undefined ? {} : { [ENV]: raw })).toThrow(
				PublicAllowlistError,
			);
		}
	});

	test("entries that are neither an owner nor an owner/repo refuse", () => {
		for (const raw of ["os eco", "-os-eco", "os:eco", "*"]) {
			expect(() => loadPublicAllowlistFromEnv({ [ENV]: raw })).toThrow(/is not a GitHub owner/);
		}
	});

	test("a pasted URL refuses — it has too many segments to be either shape", () => {
		expect(() => loadPublicAllowlistFromEnv({ [ENV]: "https://github.com/os-eco/warren" })).toThrow(
			/too many path segments/,
		);
	});

	test("the refusal names the env var so the operator knows what to set", () => {
		expect(() => loadPublicAllowlistFromEnv({})).toThrow(ENV);
	});
});

describe("resolvePublicAllowlist", () => {
	test("token mode opts out entirely — a bad allowlist isn't even parsed", () => {
		expect(resolvePublicAllowlist("token", {})).toBeUndefined();
		expect(resolvePublicAllowlist("token", { [ENV]: "os-eco/warren" })).toBeUndefined();
	});

	test("public mode parses the list", () => {
		const allowlist = resolvePublicAllowlist("public", { [ENV]: "os-eco" });
		expect(allowlist).toBeDefined();
		expect(allowlist?.owners.has("os-eco")).toBe(true);
	});

	test("public mode with no allowlist refuses the boot", () => {
		expect(() => resolvePublicAllowlist("public", {})).toThrow(PublicAllowlistError);
	});
});

describe("isRepoAllowlisted", () => {
	test("an owner entry admits every repo beneath it, case-insensitively", () => {
		expect(isRepoAllowlisted(ALLOWED, "os-eco", "warren")).toBe(true);
		expect(isRepoAllowlisted(ALLOWED, "OS-ECO", "anything")).toBe(true);
		expect(isRepoAllowlisted(ALLOWED, " os-eco ", "whatever")).toBe(true);
	});

	test("no substring or prefix match on the owner", () => {
		expect(isRepoAllowlisted(ALLOWED, "os", "warren")).toBe(false);
		expect(isRepoAllowlisted(ALLOWED, "os-eco-evil", "warren")).toBe(false);
		expect(isRepoAllowlisted(ALLOWED, "evil-os-eco", "warren")).toBe(false);
	});

	// The whole point of warren-1841: an owner with private repos must be
	// expressible WITHOUT admitting all of them.
	test("a repo entry admits only itself, not its siblings under the same owner", () => {
		expect(isRepoAllowlisted(REPO_SCOPED, "some-owner", "public-repo")).toBe(true);
		expect(isRepoAllowlisted(REPO_SCOPED, "some-owner", "other-public-repo")).toBe(true);
		expect(isRepoAllowlisted(REPO_SCOPED, "some-owner", "private-repo")).toBe(false);
		expect(isRepoAllowlisted(REPO_SCOPED, "some-owner", "another-private-repo")).toBe(false);
	});

	test("a repo entry matches case-insensitively on both segments", () => {
		expect(isRepoAllowlisted(REPO_SCOPED, "SOME-OWNER", "PUBLIC-REPO")).toBe(true);
	});

	test("no substring match on the repo name either", () => {
		expect(isRepoAllowlisted(REPO_SCOPED, "some-owner", "public-repo-evil")).toBe(false);
		expect(isRepoAllowlisted(REPO_SCOPED, "some-owner", "public")).toBe(false);
	});
});

describe("repo entries", () => {
	test("owner and owner/repo entries coexist in one list", () => {
		const list = loadPublicAllowlistFromEnv({ [ENV]: "my-org,some-owner/public-repo" });
		expect([...list.owners]).toEqual(["my-org"]);
		expect([...list.repos]).toEqual(["some-owner/public-repo"]);
		expect(isRepoAllowlisted(list, "my-org", "anything")).toBe(true);
		expect(isRepoAllowlisted(list, "some-owner", "public-repo")).toBe(true);
		expect(isRepoAllowlisted(list, "some-owner", "private-repo")).toBe(false);
	});

	test("a .git suffix on an entry is tolerated, matching parseGitHubUrl", () => {
		const list = loadPublicAllowlistFromEnv({ [ENV]: "some-owner/public-repo.git" });
		expect(isRepoAllowlisted(list, "some-owner", "public-repo")).toBe(true);
	});

	test("entries are validated by parseGitHubUrl, so path escapes refuse", () => {
		for (const raw of ["some-owner/..", "some-owner/.", "-bad/some-repo"]) {
			expect(() => loadPublicAllowlistFromEnv({ [ENV]: raw })).toThrow(PublicAllowlistError);
		}
	});

	// The case this was built for: private repos sitting under the same
	// owner as the public ones. An owner list cannot express it.
	test("a repo list refuses a private sibling the owner list would have admitted", () => {
		const byOwner = loadPublicAllowlistFromEnv({ [ENV]: "some-owner" });
		const byRepo = loadPublicAllowlistFromEnv({ [ENV]: "some-owner/public-repo" });
		const priv = [{ id: "p1", gitUrl: "https://github.com/some-owner/private-repo.git" }];
		expect(() => assertRegisteredProjectsAllowlisted(byOwner, priv)).not.toThrow();
		expect(() => assertRegisteredProjectsAllowlisted(byRepo, priv)).toThrow(PublicAllowlistError);
	});
});

describe("the legacy env name", () => {
	const LEGACY = "WARREN_PUBLIC_ORG_ALLOWLIST";

	test("is still read, so a copied .env does not silently lose its allowlist", () => {
		const list = loadPublicAllowlistFromEnv({ [LEGACY]: "os-eco" }, silent);
		expect(list.owners.has("os-eco")).toBe(true);
	});

	test("warns when it supplies the value", () => {
		let warned = "";
		loadPublicAllowlistFromEnv({ [LEGACY]: "os-eco" }, (m) => {
			warned = m;
		});
		expect(warned).toContain(LEGACY);
		expect(warned).toContain(ENV);
	});

	test("the current name wins and warns about nothing", () => {
		let warned = "";
		const list = loadPublicAllowlistFromEnv({ [ENV]: "current", [LEGACY]: "legacy" }, (m) => {
			warned = m;
		});
		expect(list.owners.has("current")).toBe(true);
		expect(list.owners.has("legacy")).toBe(false);
		expect(warned).toBe("");
	});

	test("it accepts repo entries too — the deprecation is the name, not the shape", () => {
		const list = loadPublicAllowlistFromEnv({ [LEGACY]: "some-owner/public-repo" }, silent);
		expect(isRepoAllowlisted(list, "some-owner", "public-repo")).toBe(true);
	});
});

describe("assertGitUrlAllowlisted", () => {
	test("token mode (undefined allowlist) is a no-op", () => {
		expect(() =>
			assertGitUrlAllowlisted(undefined, "https://github.com/somebody/private"),
		).not.toThrow();
	});

	test("accepts every URL shape parseGitHubUrl accepts", () => {
		for (const url of [
			"https://github.com/os-eco/warren",
			"https://github.com/os-eco/warren.git",
			"git@github.com:os-eco/warren.git",
			"ssh://git@github.com/OS-ECO/warren",
		]) {
			expect(() => assertGitUrlAllowlisted(ALLOWED, url)).not.toThrow();
		}
	});

	test("a non-allowlisted org is a ValidationError (HTTP 400) naming the org", () => {
		expect(() => assertGitUrlAllowlisted(ALLOWED, "https://github.com/somebody/private")).toThrow(
			ValidationError,
		);
		expect(() => assertGitUrlAllowlisted(ALLOWED, "https://github.com/somebody/private")).toThrow(
			/"somebody\/private" is not on this public instance's allowlist/,
		);
	});

	test("an unparseable url still rejects (parseGitHubUrl's own message)", () => {
		expect(() => assertGitUrlAllowlisted(ALLOWED, "not-a-url")).toThrow(ValidationError);
	});
});

describe("assertRegisteredProjectsAllowlisted", () => {
	test("token mode (undefined allowlist) is a no-op", () => {
		expect(() =>
			assertRegisteredProjectsAllowlisted(undefined, [
				{ id: "p1", gitUrl: "https://github.com/somebody/private" },
			]),
		).not.toThrow();
	});

	test("an empty instance and an all-allowlisted instance both boot", () => {
		expect(() => assertRegisteredProjectsAllowlisted(ALLOWED, [])).not.toThrow();
		expect(() =>
			assertRegisteredProjectsAllowlisted(ALLOWED, [
				{ id: "p1", gitUrl: "https://github.com/os-eco/warren.git" },
				{ id: "p2", gitUrl: "git@github.com:some-owner/other-public-repo.git" },
			]),
		).not.toThrow();
	});

	test("one offender refuses the boot, naming its id and url", () => {
		expect(() =>
			assertRegisteredProjectsAllowlisted(ALLOWED, [
				{ id: "p1", gitUrl: "https://github.com/os-eco/warren.git" },
				{ id: "p2", gitUrl: "https://github.com/somebody/private.git" },
			]),
		).toThrow(PublicAllowlistError);
		expect(() =>
			assertRegisteredProjectsAllowlisted(ALLOWED, [
				{ id: "p2", gitUrl: "https://github.com/somebody/private.git" },
			]),
		).toThrow(/p2 \(https:\/\/github.com\/somebody\/private.git\)/);
	});

	test("every offender is named in one message, not just the first", () => {
		let message = "";
		try {
			assertRegisteredProjectsAllowlisted(ALLOWED, [
				{ id: "p1", gitUrl: "https://github.com/somebody/private.git" },
				{ id: "p2", gitUrl: "https://github.com/os-eco/warren.git" },
				{ id: "p3", gitUrl: "https://github.com/elsewhere/other.git" },
			]);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("2 registered project(s)");
		expect(message).toContain("p1");
		expect(message).toContain("p3");
		expect(message).not.toContain("p2");
	});

	// A tampered or legacy row must not slip through on a parse failure.
	test("an unparseable stored gitUrl counts as NOT allowlisted", () => {
		expect(() =>
			assertRegisteredProjectsAllowlisted(ALLOWED, [{ id: "p9", gitUrl: "file:///etc/passwd" }]),
		).toThrow(PublicAllowlistError);
	});
});

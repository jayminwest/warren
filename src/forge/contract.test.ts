/**
 * The forge seam's vocabulary must stay DERIVED from `src/core/wire.ts`
 * (warren-0993). `check:wire-types` matches on names, so an aliased
 * re-export is invisible to it. These assertions are the mechanical
 * stand-in, copied from `src/runtime/contract.test.ts`: they fail to compile
 * the moment either side grows or loses a member.
 *
 * The second half is the CONTRACT CONFORMANCE suite, run against FakeForge
 * (implementation #2). When GitHubForge lands it runs the same suite, which
 * is the point of cutting the contract against two implementations.
 */

import { describe, expect, test } from "bun:test";
import {
	FORGE_ERROR_KINDS,
	type ForgeErrorKind,
	PULL_REQUEST_LIFECYCLES,
	type PullRequestLifecycle,
} from "../core/wire.ts";
import type { Forge, PullRequestState } from "./contract.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import { GitHubForge } from "./github/provider.ts";
import { stubGitHubServer } from "./github/stub-server.ts";
import { GitHubAppForge } from "./github-app/provider.ts";
import { generateTestAppKeyPair, stubGitHubAppServer } from "./github-app/test-helpers.ts";

/** Compile-time mutual assignability: `A extends B` and `B extends A`. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

function assertExact<T extends true>(_witness: T): void {
	/* type-level only */
}

describe("forge contract vocabulary", () => {
	test("derives the contract PullRequestLifecycle from the canonical one", () => {
		assertExact<Exact<PullRequestState["lifecycle"], PullRequestLifecycle>>(true);
		const lifecycles: PullRequestState["lifecycle"][] = [...PULL_REQUEST_LIFECYCLES];
		expect(lifecycles).toEqual(["open", "merged", "closed_unmerged"]);
	});

	test("derives the seam ForgeErrorKind from the canonical one", () => {
		assertExact<Exact<ForgeErrorKind, (typeof FORGE_ERROR_KINDS)[number]>>(true);
		expect([...FORGE_ERROR_KINDS]).toHaveLength(10);
	});
});

/** Per-implementation knobs the conformance suite branches on. */
export interface ForgeConformanceOptions {
	/** A clone URL in this forge's own grammar. */
	readonly cloneUrl: string;
	/** The registry key `parseRepoRef` packs into the ref. */
	readonly forgeKind: string;
	/** URLs this forge must reject (foreign grammars). */
	readonly foreignUrls: readonly string[];
	/** false when the forge names no bot (GitHub PAT mode, §5). */
	readonly botIdentity: boolean;
	/** true when minted credentials carry a real expiry (GitHub App mode, §4). */
	readonly shortLivedCredential?: boolean;
}

/** Conformance: every Forge implementation must satisfy these behaviours. */
export function forgeConformanceSuite(makeForge: () => Forge, opts: ForgeConformanceOptions): void {
	const CLONE_URL = opts.cloneUrl;
	const draft = {
		title: "Add the widget",
		body: "Body text.",
		headBranch: "warren/run-1",
		baseBranch: "main",
	};

	function setup(): { forge: Forge; ref: NonNullable<ReturnType<Forge["parseRepoRef"]>> } {
		const forge = makeForge();
		const ref = forge.parseRepoRef(CLONE_URL);
		if (ref === null) throw new Error("parseRepoRef rejected its own grammar");
		return { forge, ref };
	}

	test("declares capabilities as the first member", () => {
		const { forge } = setup();
		expect(typeof forge.capabilities.checkRuns).toBe("boolean");
		expect(["static", "short-lived"]).toContain(forge.capabilities.credentialLifetime);
	});

	test("parseRepoRef round-trips its own grammar and rejects foreign URLs", () => {
		const { forge, ref } = setup();
		expect(ref.forge).toBe(opts.forgeKind);
		expect(ref.key.length).toBeGreaterThan(0);
		for (const foreign of opts.foreignUrls) {
			expect(forge.parseRepoRef(foreign)).toBeNull();
		}
		expect(forge.parseRepoRef("not a url")).toBeNull();
	});

	test("gitCredential mints a credential carrying an expiry field", async () => {
		const { forge, ref } = setup();
		const result = await forge.gitCredential(ref);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.username.length).toBeGreaterThan(0);
			expect(result.value.secret.length).toBeGreaterThan(0);
			if (opts.shortLivedCredential === true) {
				expect(typeof result.value.expiresAt).toBe("number");
			} else {
				expect(result.value.expiresAt).toBeNull();
			}
		}
	});

	test("openPullRequest is idempotent on the head/base pair", async () => {
		const { forge, ref } = setup();
		const first = await forge.openPullRequest(ref, draft);
		const second = await forge.openPullRequest(ref, draft);
		expect(first.ok && second.ok).toBe(true);
		if (first.ok && second.ok) {
			expect(second.value.number).toBe(first.value.number);
			expect(second.value.key).toBe(first.value.key);
			expect(first.value.webUrl).toContain(String(first.value.number));
		}
	});

	test("findPullRequest returns ok-null when none exists, and the PR when it does", async () => {
		const { forge, ref } = setup();
		const missing = await forge.findPullRequest(ref, {
			headBranch: "warren/none",
			baseBranch: "main",
		});
		expect(missing.ok).toBe(true);
		if (missing.ok) expect(missing.value).toBeNull();

		const opened = await forge.openPullRequest(ref, draft);
		expect(opened.ok).toBe(true);
		const found = await forge.findPullRequest(ref, {
			headBranch: draft.headBranch,
			baseBranch: draft.baseBranch,
		});
		expect(found.ok).toBe(true);
		if (found.ok && opened.ok) expect(found.value?.number).toBe(opened.value.number);
	});

	test("getPullRequest reports lifecycle state; a missing PR is a not_found error", async () => {
		const { forge, ref } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const state = await forge.getPullRequest(ref, opened.value);
		expect(state.ok).toBe(true);
		if (state.ok) {
			expect(state.value.lifecycle).toBe("open");
			expect(state.value.mergedAt).toBeNull();
			expect(state.value.baseBranch).toBe("main");
			expect(state.value.headCommit.length).toBeGreaterThan(0);
		}
		const gone = await forge.getPullRequest(ref, { ...opened.value, number: 9999 });
		expect(gone.ok).toBe(false);
		if (!gone.ok) expect(gone.error.kind).toBe("not_found");
	});

	test("setPullRequestBody transports the domain-composed body", async () => {
		const { forge, ref } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const edited = await forge.setPullRequestBody(ref, opened.value, "Rewritten.");
		expect(edited.ok).toBe(true);
		const missing = await forge.setPullRequestBody(ref, { ...opened.value, number: 9999 }, "x");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.kind).toBe("not_found");
	});

	test("listChecks rolls a commit's runs up to a conclusion", async () => {
		const { forge, ref } = setup();
		const empty = await forge.listChecks(ref, "sha-empty");
		expect(empty.ok).toBe(true);
		if (empty.ok) expect(empty.value.conclusion).toBe("unknown");
	});

	test("fetchJobLogTail is best-effort and tails to maxBytes", async () => {
		const { forge, ref } = setup();
		const log = await forge.fetchJobLogTail(ref, "job-7", 64);
		expect(log.ok).toBe(true);
		if (log.ok) {
			expect(log.value).not.toBeNull();
			expect(log.value?.length).toBeLessThanOrEqual(64);
		}
	});

	test("deleteBranch succeeds through the seam", async () => {
		const { forge, ref } = setup();
		const result = await forge.deleteBranch(ref, "warren/run-1");
		expect(result.ok).toBe(true);
	});

	test("botIdentity names the forge's bot, or reports unsupported (§5)", async () => {
		const { forge } = setup();
		const identity = await forge.botIdentity();
		expect(identity.ok).toBe(opts.botIdentity);
		if (identity.ok) {
			expect(identity.value.name.length).toBeGreaterThan(0);
			expect(identity.value.email).toContain("@");
		} else {
			expect(identity.error.kind).toBe("unsupported");
		}
	});
}

describe("FakeForge conforms to the Forge contract", () => {
	forgeConformanceSuite(() => new FakeForge(), {
		cloneUrl: "fake://projects/widget",
		forgeKind: "fake",
		foreignUrls: ["https://github.com/o/r.git", "git@github.com:o/r.git"],
		botIdentity: true,
	});
});

describe("GitHubForge conforms to the Forge contract", () => {
	forgeConformanceSuite(
		() => new GitHubForge({ token: "test-token", fetch: stubGitHubServer().fetch }),
		{
			cloneUrl: "https://github.com/octo/widget.git",
			forgeKind: "github",
			foreignUrls: ["fake://projects/widget", "https://gitlab.com/o/r.git"],
			botIdentity: false,
		},
	);
});

describe("GitHubAppForge conforms to the Forge contract", () => {
	forgeConformanceSuite(
		() =>
			new GitHubAppForge({
				appId: "4560297",
				installationId: "555",
				privateKey: generateTestAppKeyPair().privateKeyPem,
				fetch: stubGitHubAppServer().fetch,
			}),
		{
			cloneUrl: "https://github.com/octo/widget.git",
			forgeKind: "github",
			foreignUrls: ["fake://projects/widget", "https://gitlab.com/o/r.git"],
			botIdentity: true,
			shortLivedCredential: true,
		},
	);
});

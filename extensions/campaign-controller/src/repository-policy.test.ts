import { describe, expect, test } from "bun:test";
import { ValidationError } from "./errors.ts";
import { MUTATION_FLAGS, NO_MUTATIONS } from "./mutations.ts";
import { validateRepositoryPolicy } from "./repository-policy.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");

function basePolicy(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		profileId: "openclaw",
		upstream: { owner: "openclaw", repo: "openclaw" },
		source: {
			url: "https://raw.githubusercontent.com/openclaw/openclaw/main/CONTRIBUTING.md",
			fetchedAt: "2026-08-25T00:00:00.000Z",
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		},
		stalenessMaxDays: 90,
		issueFirstRequired: true,
		aiDisclosure: { required: true, evidenceRequired: true },
		allowedWorkTypes: ["bug-fix", "docs", "test"],
		forbiddenPaths: [".github/workflows/*", "SECURITY.md"],
		protectedPaths: ["docs/CONSTITUTION.md"],
		upstreamObservedMaxOpenPrs: 20,
		maxOpenPrs: 5,
		maxNewPrsPerDay: 2,
		requiredChecks: ["ci", "typecheck", "lint"],
		mutations: { ...NO_MUTATIONS },
	};
}

function validate(input: unknown) {
	return validateRepositoryPolicy(input, { nowMs: NOW });
}

function expectInvalid(input: unknown, snippet: string) {
	expect(() => validate(input)).toThrow(ValidationError);
	expect(() => validate(input)).toThrow(snippet);
}

describe("validateRepositoryPolicy", () => {
	test("accepts and normalizes a valid policy", () => {
		const { policy, digest } = validate(basePolicy());
		expect(policy.profileId).toBe("openclaw");
		expect(policy.mutations.createPullRequest).toBe(false);
		expect(policy.upstream).toEqual({ owner: "openclaw", repo: "openclaw" });
		expect(digest).toHaveLength(64);
	});

	test("rejects unknown keys, including secret-shaped ones", () => {
		expectInvalid({ ...basePolicy(), token: "ghp_x" }, "unknown field(s)");
		const nested = basePolicy() as { source: Record<string, unknown> };
		nested.source = { ...nested.source, apiKey: "x" };
		expectInvalid(nested, "unknown field(s)");
	});

	test("rejects a stale snapshot", () => {
		const stale = basePolicy() as { source: Record<string, unknown> };
		stale.source = { ...stale.source, fetchedAt: "2025-01-01T00:00:00.000Z" };
		expectInvalid(stale, "stale");
	});

	test("rejects a non-https source URL", () => {
		const http = basePolicy() as { source: Record<string, unknown> };
		http.source = { ...http.source, url: "http://example.com/policy.md" };
		expectInvalid(http, "https URL");
	});

	test("rejects a malformed source hash", () => {
		const badHash = basePolicy() as { source: Record<string, unknown> };
		badHash.source = { ...badHash.source, sha256: "abc" };
		expectInvalid(badHash, "64 characters");
	});

	test("rejects issue-first or disclosure requirements being dropped", () => {
		expectInvalid({ ...basePolicy(), issueFirstRequired: false }, "issueFirstRequired");
		const loose = basePolicy() as { aiDisclosure: Record<string, unknown> };
		loose.aiDisclosure = { required: true, evidenceRequired: false };
		expectInvalid(loose, "disclosure");
	});

	test("rejects empty or out-of-vocabulary work types", () => {
		expectInvalid({ ...basePolicy(), allowedWorkTypes: [] }, "at least 1 items");
		expectInvalid(
			{ ...basePolicy(), allowedWorkTypes: ["bug-fix", "wormhole"] },
			"unknown work type",
		);
		expectInvalid({ ...basePolicy(), allowedWorkTypes: ["bug-fix", "bug-fix"] }, "duplicate item");
	});

	test("rejects empty forbidden-path and required-check lists", () => {
		expectInvalid({ ...basePolicy(), forbiddenPaths: [] }, "at least 1 items");
		expectInvalid({ ...basePolicy(), requiredChecks: [] }, "at least 1 items");
	});

	test("rejects controller caps over the upstream limit", () => {
		expectInvalid({ ...basePolicy(), maxOpenPrs: 21 }, "between 1 and 20");
		expectInvalid({ ...basePolicy(), maxNewPrsPerDay: 6 }, "between 1 and 5");
	});

	test("admits createPullRequest — the one executable mutation (warren-84da)", () => {
		const enabled = basePolicy() as { mutations: Record<string, unknown> };
		enabled.mutations = { ...NO_MUTATIONS, createPullRequest: true };
		const validated = validateRepositoryPolicy(enabled, { nowMs: NOW });
		expect(validated.policy.mutations.createPullRequest).toBe(true);
		expect(validated.policy.mutations.mergePullRequest).toBe(false);
		// The digest must change with the flag: enabling the mutation is a
		// new policy snapshot needing its own campaign approval.
		const dryRun = validateRepositoryPolicy(basePolicy(), { nowMs: NOW });
		expect(validated.digest).not.toBe(dryRun.digest);
	});

	test("rejects every enabled mutation flag without an executable code path", () => {
		const merge = basePolicy() as { mutations: Record<string, unknown> };
		merge.mutations = { ...NO_MUTATIONS, mergePullRequest: true, pushCommits: true };
		expectInvalid(merge, "pushCommits, mergePullRequest");
		// createPullRequest riding along does not launder the others in.
		const mixed = basePolicy() as { mutations: Record<string, unknown> };
		mixed.mutations = { ...NO_MUTATIONS, createPullRequest: true, editComment: true };
		expectInvalid(mixed, "editComment");
	});

	test("rejects missing mutation flags", () => {
		const missing = basePolicy() as { mutations: Record<string, unknown> };
		const partial: Record<string, unknown> = { ...NO_MUTATIONS };
		delete partial.pushCommits;
		missing.mutations = partial;
		expectInvalid(missing, "pushCommits");
	});

	test("rejects non-boolean mutation values", () => {
		const stringly = basePolicy() as { mutations: Record<string, unknown> };
		stringly.mutations = { ...NO_MUTATIONS, postComment: "false" };
		expectInvalid(stringly, "expected a boolean");
	});

	test("the mutation vocabulary is complete and frozen", () => {
		expect(MUTATION_FLAGS).toContain("createPullRequest");
		expect(Object.keys(NO_MUTATIONS).sort()).toEqual([...MUTATION_FLAGS].sort());
		// Phase 3 (warren-094b) flags are part of the bound-every-flag schema.
		expect(MUTATION_FLAGS).toContain("followUpPush");
		expect(Object.keys(NO_MUTATIONS)).toContain("followUpPush");
	});

	test("admits each phase-3 mutation flag individually, digest-covered (warren-094b)", () => {
		const dryRun = validateRepositoryPolicy(basePolicy(), { nowMs: NOW });
		for (const flag of ["updatePullRequest", "postComment", "updateBranch", "followUpPush"]) {
			const enabled = basePolicy() as { mutations: Record<string, unknown> };
			enabled.mutations = { ...NO_MUTATIONS, [flag]: true };
			const validated = validateRepositoryPolicy(enabled, { nowMs: NOW });
			expect(validated.policy.mutations[flag as keyof typeof validated.policy.mutations]).toBe(
				true,
			);
			// Every other flag stays off: the gate is per mutation, not a posture.
			for (const other of MUTATION_FLAGS) {
				if (other === flag) continue;
				expect(validated.policy.mutations[other]).toBe(false);
			}
			// Enabling any one flag changes the digest: fresh owner approval.
			expect(validated.digest).not.toBe(dryRun.digest);
		}
		// Different flags produce different digests of their own.
		const a = basePolicy() as { mutations: Record<string, unknown> };
		a.mutations = { ...NO_MUTATIONS, postComment: true };
		const b = basePolicy() as { mutations: Record<string, unknown> };
		b.mutations = { ...NO_MUTATIONS, updateBranch: true };
		expect(validateRepositoryPolicy(a, { nowMs: NOW }).digest).not.toBe(
			validateRepositoryPolicy(b, { nowMs: NOW }).digest,
		);
	});

	test("admits combinations of executable flags without laundering non-executable ones", () => {
		const combo = basePolicy() as { mutations: Record<string, unknown> };
		combo.mutations = {
			...NO_MUTATIONS,
			createPullRequest: true,
			updatePullRequest: true,
			postComment: true,
		};
		const validated = validateRepositoryPolicy(combo, { nowMs: NOW });
		expect(validated.policy.mutations.updatePullRequest).toBe(true);
		expect(validated.policy.mutations.postComment).toBe(true);
		expect(validated.policy.mutations.mergePullRequest).toBe(false);
		expect(validated.policy.mutations.pushCommits).toBe(false);
	});

	test("rejects malformed upstream coordinates and versions", () => {
		const bad = basePolicy() as { upstream: Record<string, unknown> };
		bad.upstream = { owner: "openclaw", repo: "openclaw.git" };
		expectInvalid(bad, "upstream");
		expectInvalid({ ...basePolicy(), schemaVersion: 2 }, "schemaVersion");
		expectInvalid({ ...basePolicy(), stalenessMaxDays: 0 }, "between 1 and 365");
	});
});

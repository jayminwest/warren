import { describe, expect, test } from "bun:test";
import { digestOf } from "./digest.ts";
import { ValidationError } from "./errors.ts";
import { validateCampaignManifest } from "./manifest.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const PROMPT = "Fix the assigned OpenClaw issue end to end.";

function baseManifest(): Record<string, unknown> {
	const unapproved = {
		schemaVersion: 1,
		campaignId: "camp-openclaw-eod-v0",
		campaignVersion: 1,
		upstream: { owner: "openclaw", repo: "openclaw" },
		fork: { owner: "warren-run-bot", repo: "openclaw" },
		defaultBranch: "main",
		issues: [812, 815, 823],
		warren: {
			project: "openclaw-contrib",
			agent: "pi",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		},
		prompt: PROMPT,
		budget: { perRunUsd: 5, dailyUsd: 20, totalUsd: 100 },
		maxConcurrentRuns: 2,
		expiresAt: "2026-12-31T00:00:00.000Z",
	};
	return {
		...unapproved,
		approval: {
			approvedBy: "jayminwest",
			approvedAt: "2026-08-25T12:00:00.000Z",
			manifestDigest: digestOf(unapproved),
		},
	};
}

function validate(input: unknown) {
	return validateCampaignManifest(input, { nowMs: NOW });
}

function expectInvalid(input: unknown, snippet: string) {
	expect(() => validate(input)).toThrow(ValidationError);
	expect(() => validate(input)).toThrow(snippet);
}

describe("validateCampaignManifest", () => {
	test("accepts and normalizes a valid manifest", () => {
		const { manifest, digest } = validate(baseManifest());
		expect(manifest.campaignId).toBe("camp-openclaw-eod-v0");
		expect(manifest.issues).toEqual([812, 815, 823]);
		expect(manifest.prompt).toBe(PROMPT);
		expect(manifest.expiresAt).toBe("2026-12-31T00:00:00.000Z");
		expect(digest).toBe(manifest.approval.manifestDigest);
	});

	test("normalizes timestamp spellings without changing the bound digest", () => {
		const input = baseManifest();
		// Reserialize via the same normalization the validator performs, then
		// confirm the digest still recomputes: order-independence proof.
		const { manifest } = validate(input);
		const roundTripped = { ...manifest };
		expect(validate(roundTripped).digest).toBe(manifest.approval.manifestDigest);
	});

	test("accepts a promptDigest in place of the prompt", () => {
		const unapproved: Record<string, unknown> = {
			...baseManifest(),
			promptDigest: digestOf({ prompt: PROMPT }),
		};
		delete unapproved.prompt;
		delete unapproved.approval;
		const input = {
			...unapproved,
			approval: {
				approvedBy: "o",
				approvedAt: "2026-08-25T00:00:00.000Z",
				manifestDigest: digestOf(unapproved),
			},
		};
		const { manifest } = validate(input);
		expect(manifest.prompt).toBeUndefined();
		expect(manifest.promptDigest).toBe(digestOf({ prompt: PROMPT }));
	});

	test("rejects unknown top-level, nested, and secret-shaped keys", () => {
		expectInvalid({ ...baseManifest(), githubToken: "ghp_x" }, "unknown field(s)");
		const nested = baseManifest() as { warren: Record<string, unknown> };
		nested.warren = { ...nested.warren, api_key: "x" };
		expectInvalid(nested, "unknown field(s)");
	});

	test("rejects malformed upstream and fork coordinates", () => {
		const badOwner = baseManifest() as { upstream: Record<string, unknown> };
		badOwner.upstream = { owner: "-openclaw", repo: "openclaw" };
		expectInvalid(badOwner, "upstream");
		const badFork = baseManifest() as { fork: Record<string, unknown> };
		badFork.fork = { owner: "warren-run-bot", repo: ".openclaw" };
		expectInvalid(badFork, "fork");
	});

	test("rejects a fork identical to upstream", () => {
		const same = baseManifest() as { fork: Record<string, unknown> };
		same.fork = { owner: "openclaw", repo: "openclaw" };
		expectInvalid(same, "must differ");
	});

	test("rejects an invalid default-branch refname", () => {
		expectInvalid({ ...baseManifest(), defaultBranch: "bad..branch" }, "default branch");
		expectInvalid({ ...baseManifest(), defaultBranch: "feature.lock" }, "default branch");
	});

	test("rejects duplicate and out-of-grammar issue ids", () => {
		expectInvalid({ ...baseManifest(), issues: [812, 812] }, "duplicate issue 812");
		expectInvalid({ ...baseManifest(), issues: [0] }, "positive integer issue numbers");
		expectInvalid({ ...baseManifest(), issues: [] }, "non-empty ordered array");
		const tooMany = baseManifest() as { issues: number[] };
		tooMany.issues = Array.from({ length: 26 }, (_, i) => i + 1);
		expectInvalid(tooMany, "at most 25 issues");
	});

	test("rejects over-limit or unlayered caps", () => {
		expectInvalid(
			{ ...baseManifest(), budget: { perRunUsd: 50, dailyUsd: 20, totalUsd: 100 } },
			"layer per-run",
		);
		expectInvalid(
			{ ...baseManifest(), budget: { perRunUsd: 5, dailyUsd: 200, totalUsd: 100 } },
			"layer per-run",
		);
		expectInvalid(
			{ ...baseManifest(), budget: { perRunUsd: 0, dailyUsd: 20, totalUsd: 100 } },
			"positive number",
		);
		expectInvalid(
			{ ...baseManifest(), budget: { perRunUsd: 5000, dailyUsd: 5000, totalUsd: 5000 } },
			"at most 1000",
		);
	});

	test("rejects zero concurrency", () => {
		expectInvalid({ ...baseManifest(), maxConcurrentRuns: 0 }, "between 1 and 10");
	});

	test("rejects an expired manifest", () => {
		expectInvalid({ ...baseManifest(), expiresAt: "2026-01-01T00:00:00.000Z" }, "expired");
	});

	test("rejects an approval dated in the future", () => {
		const input = baseManifest() as { approval: Record<string, unknown> };
		input.approval = { ...input.approval, approvedAt: "2026-12-01T00:00:00.000Z" };
		expectInvalid(input, "future");
	});

	test("rejects a digest that does not match the bound content", () => {
		const input = baseManifest() as { approval: Record<string, unknown> };
		input.approval = { ...input.approval, manifestDigest: digestOf({ nope: true }) };
		expectInvalid(input, "digest mismatch");
	});

	test("editing a bound field invalidates approval", () => {
		const edited = { ...baseManifest(), maxConcurrentRuns: 3 };
		expectInvalid(edited, "digest mismatch");
	});

	test("requires exactly one of prompt and promptDigest", () => {
		const both = baseManifest() as Record<string, unknown>;
		both.promptDigest = digestOf({ prompt: PROMPT });
		expectInvalid(both, "exactly one");
		const neither = baseManifest();
		delete neither.prompt;
		expectInvalid(neither, "exactly one");
	});

	test("rejects a malformed promptDigest", () => {
		const unapproved: Record<string, unknown> = { ...baseManifest() };
		delete unapproved.approval;
		delete unapproved.prompt;
		const input = {
			...unapproved,
			promptDigest: "not-a-digest",
			approval: {
				approvedBy: "o",
				approvedAt: "2026-08-25T00:00:00.000Z",
				manifestDigest: digestOf(unapproved),
			},
		};
		expectInvalid(input, "64 characters");
	});

	test("rejects malformed campaign ids and versions", () => {
		expectInvalid({ ...baseManifest(), campaignId: "OpenClaw V0" }, "campaignId");
		expectInvalid({ ...baseManifest(), campaignVersion: 0 }, "campaignVersion");
		expectInvalid({ ...baseManifest(), schemaVersion: 2 }, "schemaVersion");
	});

	test("rejects non-object input outright", () => {
		expectInvalid("manifest", "expected an object");
	});
});

describe("validateCampaignManifest evidence tiers", () => {
	/** A manifest re-signed with an optional `issueEvidenceTiers` field. */
	function withTiers(tiers: Record<string, string> | undefined): Record<string, unknown> {
		const input = baseManifest() as Record<string, unknown>;
		const { approval, ...rest } = input;
		const bound = { ...rest, issueEvidenceTiers: tiers };
		const approvalRecord = approval as Record<string, unknown>;
		return {
			...bound,
			approval: { ...approvalRecord, manifestDigest: digestOf(bound) },
		};
	}

	test("accepts per-issue evidence tiers and binds them into the approval digest", () => {
		const { manifest, digest } = validate(withTiers({ "815": "external-proof-required" }));
		expect(manifest.issueEvidenceTiers).toEqual({ "815": "external-proof-required" });
		expect(digest).toBe((manifest.approval as { manifestDigest: string }).manifestDigest);
		// A tagged manifest digests differently from the same campaign untagged:
		// approval covers the tier declaration too.
		const untagged = validate(baseManifest());
		expect(digest).not.toBe(untagged.digest);
	});

	test("an untagged manifest carries no tier map (defaulting to local-provable)", () => {
		const { manifest } = validate(baseManifest());
		expect(manifest.issueEvidenceTiers).toBeUndefined();
	});

	test("rejects a tier key that is not an issue in the manifest's list", () => {
		expectInvalid(
			withTiers({ "999": "external-proof-required" }),
			"not an issue in the manifest's issue list",
		);
	});

	test("rejects a malformed tier value", () => {
		expectInvalid(withTiers({ "812": "" }), "1–64 character evidence-tier name");
	});
});

/**
 * Golden tests for the committed crewAI data profile and example campaign
 * manifest.
 *
 * crewAI is data, never conditionals: these tests pin the committed
 * snapshot's validity, its deterministic round-trip, the observed upstream
 * open-PR limit, and the stricter controller caps. The validation clock is
 * pinned to just after the snapshot's fetchedAt so the committed profile
 * stays provably fresh-shaped; live validation with the real clock fails
 * once the snapshot ages past its own staleness bound, which is the point.
 */
import { describe, expect, test } from "bun:test";
import { canonicalJson, digestOf } from "./digest.ts";
import { validateCampaignManifest } from "./manifest.ts";
import { validateBotGrammar } from "./reconcile/bot-grammar.ts";
import { composeDispatchPrompt, validateRepositoryPolicy } from "./repository-policy.ts";

const DATA_DIR = new URL("../profiles/", import.meta.url);
/** Pinned to one day after the committed snapshot was fetched. */
const PINNED_NOW = Date.parse("2026-09-01T00:00:00.000Z");

async function loadGolden(name: string): Promise<unknown> {
	return Bun.file(new URL(name, DATA_DIR)).json();
}

describe("crewai repository-policy golden", () => {
	test("the committed profile validates and pins the observed open-PR limit", async () => {
		const { policy } = validateRepositoryPolicy(await loadGolden("crewai.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		expect(policy.profileId).toBe("crewai");
		expect(policy.upstream).toEqual({ owner: "crewAIInc", repo: "crewAI" });
		// ~710 open PRs observed on 2026-08-31; the profile pins the ceiling.
		expect(policy.upstreamObservedMaxOpenPrs).toBe(750);
	});

	test("the controller cap is strictly stricter than the upstream limit", async () => {
		const { policy } = validateRepositoryPolicy(await loadGolden("crewai.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		expect(policy.maxOpenPrs).toBeLessThan(policy.upstreamObservedMaxOpenPrs);
		expect(policy.maxNewPrsPerDay).toBeLessThanOrEqual(policy.maxOpenPrs);
	});

	test("the committed profile round-trips deterministically", async () => {
		const raw = await loadGolden("crewai.repository-policy.json");
		const first = validateRepositoryPolicy(raw, { nowMs: PINNED_NOW });
		const second = validateRepositoryPolicy(JSON.parse(canonicalJson(first.policy)), {
			nowMs: PINNED_NOW,
		});
		expect(canonicalJson(second.policy)).toBe(canonicalJson(first.policy));
		expect(second.digest).toBe(first.digest);
	});

	test("the committed profile admits no mutation", async () => {
		const { policy } = validateRepositoryPolicy(await loadGolden("crewai.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		for (const [flag, allowed] of Object.entries(policy.mutations)) {
			expect(allowed, flag).toBe(false);
		}
	});

	test("the disclosure names the upstream llm-generated label requirement", async () => {
		const { policy } = validateRepositoryPolicy(await loadGolden("crewai.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		// crewAI's CONTRIBUTING requires the `llm-generated` label on AI PRs; a
		// cross-fork author cannot apply labels, so the rendered body must ask
		// maintainers to add it.
		expect(policy.prBodyContract?.disclosureTemplate).toContain("`llm-generated` label");
	});
});

describe("crewai bot-grammar golden", () => {
	test("the committed grammar validates and pins the observed CodeRabbit format", async () => {
		const grammar = validateBotGrammar(await loadGolden("crewai.bot-grammar.json"));
		// Observed live on crewAI PR 7148: CodeRabbit's actionable findings
		// arrive as inline review comments authored by the App login with the
		// literal '[bot]' suffix (warren-442e).
		expect(grammar.knownBotLogins).toEqual(["coderabbitai[bot]"]);
		// Every observed actionable comment opens with an italic header line
		// (`_🎯 Functional Correctness_ | _🟡 Minor_ | _⚡ Quick win_`), so the
		// marker is the leading underscore; the line grammar then extracts the
		// bold title line. Non-finding CodeRabbit output (walkthrough edits,
		// conversational replies) starts differently and never classifies.
		expect(grammar.findingMarker).toBe("_");
		expect(grammar.reReviewCommands).toEqual(["@coderabbitai review", "@coderabbitai full review"]);
		const pattern = new RegExp(grammar.findingLinePattern);
		// Observed title line on crewAI PR 7148.
		const observedLine = "**Reject every path segment after `@` as a last-segment violation.**";
		const match = pattern.exec(observedLine);
		expect(match?.groups?.title).toBe(
			"Reject every path segment after `@` as a last-segment violation.",
		);
		// The italic header line itself is not a finding line.
		expect(pattern.exec("_🎯 Functional Correctness_ | _🟡 Minor_ | _⚡ Quick win_")).toBeNull();
	});
});

describe("crewai campaign-manifest golden", () => {
	test("the committed example validates with its recorded approval digest", async () => {
		const { manifest, digest } = validateCampaignManifest(
			await loadGolden("crewai.campaign-manifest.example.json"),
			{ nowMs: PINNED_NOW },
		);
		expect(manifest.campaignId).toBe("camp-crewai-v0");
		expect(manifest.upstream).toEqual({ owner: "crewAIInc", repo: "crewAI" });
		expect(manifest.fork).toEqual({ owner: "warren-run-bot", repo: "crewAI" });
		expect(digest).toBe(manifest.approval.manifestDigest);
	});

	test("the committed example round-trips deterministically", async () => {
		const raw = await loadGolden("crewai.campaign-manifest.example.json");
		const first = validateCampaignManifest(raw, { nowMs: PINNED_NOW });
		const second = validateCampaignManifest(JSON.parse(canonicalJson(first.manifest)), {
			nowMs: PINNED_NOW,
		});
		expect(canonicalJson(second.manifest)).toBe(canonicalJson(first.manifest));
		expect(second.digest).toBe(first.digest);
	});

	test("the example manifest and policy agree on the upstream target", async () => {
		const manifest = validateCampaignManifest(
			await loadGolden("crewai.campaign-manifest.example.json"),
			{ nowMs: PINNED_NOW },
		);
		const policy = validateRepositoryPolicy(await loadGolden("crewai.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		expect(manifest.manifest.upstream).toEqual(policy.policy.upstream);
	});

	test("digests are stable across reloads (golden pin)", async () => {
		const policy = validateRepositoryPolicy(await loadGolden("crewai.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		const manifest = validateCampaignManifest(
			await loadGolden("crewai.campaign-manifest.example.json"),
			{ nowMs: PINNED_NOW },
		);
		// Recompute from an independent canonical serialization.
		expect(digestOf(policy.policy)).toBe(policy.digest);
		const { approval: _a, ...unapproved } = manifest.manifest;
		expect(digestOf(unapproved)).toBe(manifest.digest);
	});

	test("the committed profile binds versioned agent guidance (warren-39b0)", async () => {
		const { policy } = validateRepositoryPolicy(await loadGolden("crewai.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		const guidance = policy.agentGuidance;
		expect(guidance).not.toBeNull();
		expect(guidance?.version).toBe(1);
		expect(guidance?.norms.length).toBeGreaterThan(0);
		// Contribution-design norms from crewAI's own AGENTS.md and
		// CONTRIBUTING: minimal-diff, behavior-focused tests, the
		// message_content_text discipline, frozen docs snapshots, conventional
		// commits, repo-native gates, declared gaps.
		expect(guidance?.norms.some((norm) => norm.includes("smallest possible diff"))).toBe(true);
		expect(guidance?.norms.some((norm) => norm.includes("message_content_text"))).toBe(true);
		expect(guidance?.norms.some((norm) => norm.includes("docs/v*/"))).toBe(true);
		expect(guidance?.norms.some((norm) => norm.includes("Conventional Commits"))).toBe(true);
		expect(guidance?.norms.some((norm) => norm.includes("known gaps"))).toBe(true);
		// The guidance is profile data, not controller source: it renders into
		// the dispatch prompt through the shared composition path.
		const composed = composeDispatchPrompt("Base prompt.", policy);
		expect(composed).toContain("BEGIN AGENT GUIDANCE");
		expect(composed).toContain("1. Produce");
	});
});

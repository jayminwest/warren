/**
 * Golden tests for the committed OpenClaw data profile and example campaign
 * manifest (plan pl-91b6 step 2, warren-5055).
 *
 * OpenClaw is data, never conditionals: these tests pin the committed
 * snapshot's validity, its deterministic round-trip, the upstream
 * 20-open-PR limit, and the stricter controller caps. The validation clock
 * is pinned to just after the snapshot's fetchedAt so the committed profile
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
const PINNED_NOW = Date.parse("2026-08-27T00:00:00.000Z");

async function loadGolden(name: string): Promise<unknown> {
	return Bun.file(new URL(name, DATA_DIR)).json();
}

describe("openclaw repository-policy golden", () => {
	test("the committed profile validates and pins the upstream 20-open-PR limit", async () => {
		const { policy } = validateRepositoryPolicy(
			await loadGolden("openclaw.repository-policy.json"),
			{ nowMs: PINNED_NOW },
		);
		expect(policy.profileId).toBe("openclaw");
		expect(policy.upstream).toEqual({ owner: "openclaw", repo: "openclaw" });
		// The upstream limit is profile data, pinned to the committed snapshot.
		expect(policy.upstreamObservedMaxOpenPrs).toBe(20);
	});

	test("the controller cap is strictly stricter than the upstream limit", async () => {
		const { policy } = validateRepositoryPolicy(
			await loadGolden("openclaw.repository-policy.json"),
			{ nowMs: PINNED_NOW },
		);
		expect(policy.maxOpenPrs).toBeLessThan(policy.upstreamObservedMaxOpenPrs);
		expect(policy.maxNewPrsPerDay).toBeLessThanOrEqual(policy.maxOpenPrs);
	});

	test("the committed profile round-trips deterministically", async () => {
		const raw = await loadGolden("openclaw.repository-policy.json");
		const first = validateRepositoryPolicy(raw, { nowMs: PINNED_NOW });
		const second = validateRepositoryPolicy(JSON.parse(canonicalJson(first.policy)), {
			nowMs: PINNED_NOW,
		});
		expect(canonicalJson(second.policy)).toBe(canonicalJson(first.policy));
		expect(second.digest).toBe(first.digest);
	});

	test("the committed profile admits no mutation", async () => {
		const { policy } = validateRepositoryPolicy(
			await loadGolden("openclaw.repository-policy.json"),
			{ nowMs: PINNED_NOW },
		);
		for (const [flag, allowed] of Object.entries(policy.mutations)) {
			expect(allowed, flag).toBe(false);
		}
	});
});

describe("openclaw bot-grammar golden", () => {
	test("the committed grammar validates and pins the observed ClawSweeper format", async () => {
		const grammar = validateBotGrammar(await loadGolden("openclaw.bot-grammar.json"));
		// Observed live on openclaw PR 132081: GitHub reports the App author
		// login with the literal '[bot]' suffix — the classifier exact-matches
		// the same literal (warren-442e).
		expect(grammar.knownBotLogins).toEqual(["clawsweeper[bot]"]);
		expect(grammar.findingMarker).toBe("## Findings");
		expect(grammar.reReviewCommands).toEqual(["@clawsweeper re-review"]);
		const pattern = new RegExp(grammar.findingLinePattern);
		const observedLine =
			"- [P1] Bind each delivery outcome to its originating cron run — " +
			"`src/cron/service/failure-alerts.ts:217-222`";
		const match = pattern.exec(observedLine);
		expect(match?.groups?.title).toBe("Bind each delivery outcome to its originating cron run");
		expect(match?.groups?.priority).toBe("P1");
		expect(match?.groups?.file).toBe("src/cron/service/failure-alerts.ts");
		// A "217-222" range captures only its first number.
		expect(match?.groups?.line).toBe("217");
	});
});

describe("openclaw campaign-manifest golden", () => {
	test("the committed example validates with its recorded approval digest", async () => {
		const { manifest, digest } = validateCampaignManifest(
			await loadGolden("openclaw.campaign-manifest.example.json"),
			{ nowMs: PINNED_NOW },
		);
		expect(manifest.campaignId).toBe("camp-openclaw-eod-v0");
		expect(manifest.upstream).toEqual({ owner: "openclaw", repo: "openclaw" });
		expect(manifest.fork).toEqual({ owner: "warren-run-bot", repo: "openclaw" });
		expect(digest).toBe(manifest.approval.manifestDigest);
	});

	test("the committed example round-trips deterministically", async () => {
		const raw = await loadGolden("openclaw.campaign-manifest.example.json");
		const first = validateCampaignManifest(raw, { nowMs: PINNED_NOW });
		const second = validateCampaignManifest(JSON.parse(canonicalJson(first.manifest)), {
			nowMs: PINNED_NOW,
		});
		expect(canonicalJson(second.manifest)).toBe(canonicalJson(first.manifest));
		expect(second.digest).toBe(first.digest);
	});

	test("normalization carries no keys beyond the schema", async () => {
		const raw = (await loadGolden("openclaw.campaign-manifest.example.json")) as Record<
			string,
			unknown
		>;
		const rawKeys = Object.keys(raw).sort();
		const { manifest } = validateCampaignManifest(raw, { nowMs: PINNED_NOW });
		// Normalization adds the optional-but-present `prompt: undefined` and
		// `issueEvidenceTiers: undefined` slots (warren-4dc1) and nothing else;
		// every input key survives, no extra key appears.
		expect(Object.keys(manifest).sort()).toEqual(
			Array.from(new Set([...rawKeys, "prompt", "issueEvidenceTiers"])).sort(),
		);
		// Secret-free by construction: no normalized value is a credential.
		expect(canonicalJson(manifest)).not.toMatch(/ghp_|github_pat_|token/i);
	});

	test("the example manifest and policy agree on the upstream target", async () => {
		const manifest = validateCampaignManifest(
			await loadGolden("openclaw.campaign-manifest.example.json"),
			{ nowMs: PINNED_NOW },
		);
		const policy = validateRepositoryPolicy(await loadGolden("openclaw.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		expect(manifest.manifest.upstream).toEqual(policy.policy.upstream);
	});

	test("digests are stable across reloads (golden pin)", async () => {
		const policy = validateRepositoryPolicy(await loadGolden("openclaw.repository-policy.json"), {
			nowMs: PINNED_NOW,
		});
		const manifest = validateCampaignManifest(
			await loadGolden("openclaw.campaign-manifest.example.json"),
			{ nowMs: PINNED_NOW },
		);
		// Recompute from an independent canonical serialization.
		expect(digestOf(policy.policy)).toBe(policy.digest);
		const { approval: _a, ...unapproved } = manifest.manifest;
		expect(digestOf(unapproved)).toBe(manifest.digest);
	});

	test("the committed profile binds versioned agent guidance (warren-39b0)", async () => {
		const { policy } = validateRepositoryPolicy(
			await loadGolden("openclaw.repository-policy.json"),
			{ nowMs: PINNED_NOW },
		);
		const guidance = policy.agentGuidance;
		expect(guidance).not.toBeNull();
		expect(guidance?.version).toBe(1);
		expect(guidance?.norms.length).toBeGreaterThan(0);
		// Contribution-design norms from the openclaw#131131 review failure:
		// minimal-diff, no new public config surface, no fail-closed validation
		// over previously-valid config, cite existing mechanisms, declare gaps.
		expect(guidance?.norms.some((norm) => norm.includes("smallest possible diff"))).toBe(true);
		expect(guidance?.norms.some((norm) => norm.includes("public configuration or API"))).toBe(true);
		expect(guidance?.norms.some((norm) => norm.includes("fail-closed validation"))).toBe(true);
		expect(guidance?.norms.some((norm) => norm.includes("existing mechanisms"))).toBe(true);
		expect(guidance?.norms.some((norm) => norm.includes("known gaps"))).toBe(true);
		// The guidance is profile data, not controller source: it renders into
		// the dispatch prompt through the shared composition path.
		const composed = composeDispatchPrompt("Base prompt.", policy);
		expect(composed).toContain("BEGIN AGENT GUIDANCE");
		expect(composed).toContain("1. Produce");
	});
});

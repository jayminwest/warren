/**
 * Table-driven coverage for the manifest amendment flow (plan pl-096b
 * step 3, warren-35c4): amendment schema + digest binding, in-place
 * application (same campaign row, version incremented), append/budget/
 * prompt changes, refusal of stale bases, duplicate appends, failed/
 * cancelled campaigns, and — the acceptance core — ZERO superseded
 * attention rows from a clean amendment.
 */
import { describe, expect, test } from "bun:test";
import { approveCampaign, importCampaign } from "./admission.ts";
import { type AdmissionInvariant, AdmissionRefusal } from "./admission-errors.ts";
import {
	AMENDMENT_SCHEMA_VERSION,
	applyAmendment,
	validateCampaignAmendment,
} from "./amendment.ts";
import { FixedClock, SequentialIdGenerator } from "./clock.ts";
import { digestOf } from "./digest.ts";
import { ValidationError } from "./errors.ts";
import { CampaignStateStore } from "./store/state-store.ts";
import type { CampaignRow } from "./store/types.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");

function basePolicy(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		profileId: "openclaw",
		upstream: { owner: "openclaw", repo: "openclaw" },
		source: {
			url: "https://raw.githubusercontent.com/openclaw/openclaw/main/CONTRIBUTING.md",
			fetchedAt: "2026-08-20T00:00:00.000Z",
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		},
		stalenessMaxDays: 90,
		issueFirstRequired: true,
		aiDisclosure: { required: true, evidenceRequired: true },
		allowedWorkTypes: ["bug-fix", "feature", "docs", "test", "refactor"],
		forbiddenPaths: [".github/workflows/*", "SECURITY.md"],
		protectedPaths: ["docs/CONSTITUTION.md", ".warren/triggers.yaml"],
		upstreamObservedMaxOpenPrs: 20,
		maxOpenPrs: 5,
		maxNewPrsPerDay: 2,
		requiredChecks: ["ci", "typecheck", "lint"],
		mutations: {
			createPullRequest: false,
			followUpPush: false,
			updatePullRequest: false,
			pushCommits: false,
			updateBranch: false,
			postComment: false,
			editComment: false,
			requestReview: false,
			addLabels: false,
			closePullRequest: false,
			reopenPullRequest: false,
			enableAutoMerge: false,
			mergePullRequest: false,
			editIssue: false,
		},
	};
}

function unapprovedManifest(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		campaignId: "camp-openclaw-eod-v0",
		campaignVersion: 1,
		upstream: { owner: "openclaw", repo: "openclaw" },
		fork: { owner: "warren-run-bot", repo: "openclaw" },
		defaultBranch: "main",
		issues: [812],
		warren: {
			project: "openclaw-contrib",
			agent: "pi",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		},
		prompt: "Fix the assigned OpenClaw issue end to end.",
		budget: { perRunUsd: 5, dailyUsd: 20, totalUsd: 100 },
		maxConcurrentRuns: 2,
		expiresAt: "2026-12-31T00:00:00.000Z",
	};
}

function signedManifest(overrides?: (m: Record<string, unknown>) => void): Record<string, unknown> {
	const manifest = unapprovedManifest();
	if (overrides !== undefined) overrides(manifest);
	const { approval: _omit, ...rest } = manifest;
	manifest.approval = {
		approvedBy: "jayminwest",
		approvedAt: "2026-08-25T12:00:00.000Z",
		manifestDigest: digestOf(rest),
	};
	return manifest;
}

/** A signed amendment over `baseDigest`; `mutate` runs before digesting. */
function signedAmendment(
	baseDigest: string,
	mutate?: (a: Record<string, unknown>) => void,
): Record<string, unknown> {
	const amendment: Record<string, unknown> = {
		schemaVersion: AMENDMENT_SCHEMA_VERSION,
		amendmentId: "ame-openclaw-append-915",
		campaignId: "camp-openclaw-eod-v0",
		baseManifestDigest: baseDigest,
	};
	if (mutate !== undefined) mutate(amendment);
	const { approval: _omit, ...rest } = amendment;
	amendment.approval = {
		approvedBy: "jayminwest",
		approvedAt: "2026-08-25T23:00:00.000Z",
		amendmentDigest: digestOf(rest),
	};
	return amendment;
}

function harness(): { store: CampaignStateStore } {
	const clock = new FixedClock(NOW);
	return {
		store: new CampaignStateStore(":memory:", {
			clock,
			ids: new SequentialIdGenerator(),
		}),
	};
}

function importAndApprove(h: { store: CampaignStateStore }): {
	campaign: CampaignRow;
	digest: string;
} {
	const imported = importCampaign(h.store, {
		manifest: signedManifest(),
		policy: basePolicy(),
		nowMs: NOW,
	});
	const approval = approveCampaign(h.store, {
		campaignId: imported.campaign.id,
		manifestDigest: imported.manifestDigest,
		approvedBy: "jayminwest",
		nowMs: NOW,
	});
	return { campaign: approval.campaign, digest: imported.manifestDigest };
}

function expectValidationError(fn: () => unknown, match?: RegExp): void {
	let caught: unknown;
	try {
		fn();
	} catch (cause) {
		caught = cause;
	}
	expect(caught).toBeInstanceOf(ValidationError);
	if (match !== undefined) {
		expect((caught as Error).message).toMatch(match);
	}
}

function expectRefusal(fn: () => unknown, invariant: AdmissionInvariant): void {
	let caught: unknown;
	try {
		fn();
	} catch (cause) {
		caught = cause;
	}
	expect(caught).toBeInstanceOf(AdmissionRefusal);
	expect((caught as AdmissionRefusal).invariant).toBe(invariant);
}

describe("validateCampaignAmendment", () => {
	test("validates a minimal append amendment and binds its digest", () => {
		const base = importAndApprove(harness());
		const amendment = signedAmendment(base.digest, (a) => {
			a.appendIssues = [915];
		});
		const validated = validateCampaignAmendment(amendment, { nowMs: NOW });
		expect(validated.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(validated.amendment.appendIssues).toEqual([915]);
		// Digest is canonical: key order and whitespace do not matter.
		const reordered: Record<string, unknown> = {};
		for (const key of Object.keys(amendment).reverse()) reordered[key] = amendment[key];
		expect(validateCampaignAmendment(reordered, { nowMs: NOW }).digest).toBe(validated.digest);
	});

	test("rejects unknown keys, wrong ids, bad digests, and empty change sets", () => {
		const amendment = signedAmendment("a".repeat(64));
		const bad = { ...amendment, issues: [1] };
		expectValidationError(() => validateCampaignAmendment(bad, { nowMs: NOW }), /unknown field/);
		expectValidationError(() =>
			validateCampaignAmendment({ ...amendment, amendmentId: "not-kebab" }, { nowMs: NOW }),
		);
		expectValidationError(() =>
			validateCampaignAmendment({ ...amendment, baseManifestDigest: "tooshort" }, { nowMs: NOW }),
		);
		// An amendment that changes nothing is refused.
		expectValidationError(() =>
			validateCampaignAmendment(signedAmendment("a".repeat(64)), { nowMs: NOW }),
		);
	});

	test("rejects a mismatched approval digest and future-dated approvals", () => {
		const base = importAndApprove(harness());
		const amendment = signedAmendment(base.digest, (a) => {
			a.appendIssues = [915];
		});
		const tampered = { ...amendment, appendIssues: [916] };
		expectValidationError(
			() => validateCampaignAmendment(tampered, { nowMs: NOW }),
			/digest mismatch/,
		);
		const approval = amendment.approval as {
			approvedAt: string;
			amendmentDigest: string;
			approvedBy: string;
		};
		const future = {
			...amendment,
			approval: { ...approval, approvedAt: "2099-01-01T00:00:00.000Z" },
		};
		expectValidationError(() => validateCampaignAmendment(future, { nowMs: NOW }), /future/);
	});

	test("rejects a prompt amendment that carries both prompt and promptDigest", () => {
		const amendment = signedAmendment("a".repeat(64), (a) => {
			a.prompt = "New prompt.";
			a.promptDigest = "b".repeat(64);
		});
		expectValidationError(
			() => validateCampaignAmendment(amendment, { nowMs: NOW }),
			/at most one/,
		);
	});

	test("budget amendments must still layer per-run ≤ daily ≤ total", () => {
		const amendment = signedAmendment("a".repeat(64), (a) => {
			a.budget = { perRunUsd: 50, dailyUsd: 20, totalUsd: 100 };
		});
		expectValidationError(
			() => validateCampaignAmendment(amendment, { nowMs: NOW }),
			/per-run ≤ daily ≤ total/,
		);
	});
});

describe("applyAmendment", () => {
	test("appends an issue in place: same row, version bumped, zero superseded attention", () => {
		const h = harness();
		const base = importAndApprove(h);
		const before = h.store.campaigns.getCampaign(base.campaign.id) as CampaignRow;

		const result = applyAmendment(h.store, {
			amendment: signedAmendment(base.digest, (a) => {
				a.appendIssues = [915, 920];
			}),
			nowMs: NOW,
		});

		expect(result.applied).toBe(true);
		expect(result.campaign.id).toBe(base.campaign.id);
		expect(result.manifestDigest).not.toBe(base.digest);
		const after = h.store.campaigns.getCampaign(base.campaign.id) as CampaignRow;
		expect(after.manifestDigest).toBe(result.manifestDigest);
		const manifest = JSON.parse(after.manifestJson) as {
			campaignVersion: number;
			issues: number[];
		};
		expect(manifest.campaignVersion).toBe(2);
		expect(manifest.issues).toEqual([812, 915, 920]);
		// Approval authority survives: the row stays approved.
		expect(after.approvedAtMs).toBe(before.approvedAtMs);
		// Appended work items trail the existing ones, still candidates.
		const items = h.store.campaigns.listWorkItems(base.campaign.id);
		expect(items.map((item) => item.issueRef)).toEqual(["812", "915", "920"]);
		expect(items.slice(1).every((item) => item.status === "candidate")).toBe(true);
		// THE acceptance invariant: no superseded attention noise.
		expect(h.store.events.listOpenAttention(base.campaign.id)).toEqual([]);
		expect(h.store.campaigns.listCampaigns()).toHaveLength(1);
		// The amendment is journaled append-only.
		const journal = h.store.events.listAmendments(base.campaign.id);
		expect(journal).toHaveLength(1);
		expect(journal[0]?.amendmentDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(journal[0]?.newManifestDigest).toBe(result.manifestDigest);
	});

	test("re-applying the same amendment digest is idempotent", () => {
		const h = harness();
		const base = importAndApprove(h);
		const amendment = signedAmendment(base.digest, (a) => {
			a.appendIssues = [915];
		});
		const first = applyAmendment(h.store, { amendment, nowMs: NOW });
		const second = applyAmendment(h.store, { amendment, nowMs: NOW });
		expect(second.applied).toBe(false);
		expect(second.campaign.id).toBe(first.campaign.id);
		expect(h.store.events.listAmendments(first.campaign.id)).toHaveLength(1);
		expect(h.store.campaigns.listCampaigns()).toHaveLength(1);
	});

	test("adjusting the budget cap updates the campaign ledger cap", () => {
		const h = harness();
		const base = importAndApprove(h);
		const result = applyAmendment(h.store, {
			amendment: signedAmendment(base.digest, (a) => {
				a.budget = { perRunUsd: 5, dailyUsd: 20, totalUsd: 250 };
			}),
			nowMs: NOW,
		});
		expect(result.applied).toBe(true);
		const after = h.store.campaigns.getCampaign(base.campaign.id) as CampaignRow;
		expect(after.budgetCapUsdCents).toBe(25_000);
	});

	test("a prompt amendment rebinds the manifest prompt and digest pair", () => {
		const h = harness();
		const base = importAndApprove(h);
		const result = applyAmendment(h.store, {
			amendment: signedAmendment(base.digest, (a) => {
				a.prompt = "Amended prompt: fix it faster.";
			}),
			nowMs: NOW,
		});
		const manifest = JSON.parse(
			(h.store.campaigns.getCampaign(base.campaign.id) as CampaignRow).manifestJson,
		) as { prompt?: string; promptDigest?: string };
		expect(manifest.prompt).toBe("Amended prompt: fix it faster.");
		expect(manifest.promptDigest).toBeUndefined();
		expect(result.amendedFields).toContain("prompt");
	});

	test("refuses an amendment over a stale base digest", () => {
		const h = harness();
		const base = importAndApprove(h);
		applyAmendment(h.store, {
			amendment: signedAmendment(base.digest, (a) => {
				a.appendIssues = [915];
			}),
			nowMs: NOW,
		});
		// The base digest is superseded in place; a second amendment against
		// it cannot race the first.
		expectRefusal(
			() =>
				applyAmendment(h.store, {
					amendment: signedAmendment(base.digest, (a) => {
						a.appendIssues = [916];
					}),
					nowMs: NOW,
				}),
			"campaign_unknown",
		);
	});

	test("refuses an amendment naming a different campaign", () => {
		const h = harness();
		const base = importAndApprove(h);
		expectRefusal(
			() =>
				applyAmendment(h.store, {
					amendment: signedAmendment(base.digest, (a) => {
						a.campaignId = "camp-someone-else-v1";
						a.appendIssues = [915];
					}),
					nowMs: NOW,
				}),
			"campaign_unknown",
		);
	});

	test("refuses appending an issue that is already in the campaign", () => {
		const h = harness();
		const base = importAndApprove(h);
		expectRefusal(
			() =>
				applyAmendment(h.store, {
					amendment: signedAmendment(base.digest, (a) => {
						a.appendIssues = [812];
					}),
					nowMs: NOW,
				}),
			"issue_already_admitted",
		);
	});

	test("refuses appending past the issue cap", () => {
		const h = harness();
		const base = importAndApprove(h);
		expectRefusal(
			() =>
				applyAmendment(h.store, {
					amendment: signedAmendment(base.digest, (a) => {
						a.appendIssues = Array.from({ length: 25 }, (_, i) => 900 + i);
					}),
					nowMs: NOW,
				}),
			"issue_not_in_campaign",
		);
	});

	test("refuses amending a failed or cancelled campaign; completed re-opens", () => {
		const h = harness();
		const failed = importAndApprove(h);
		h.store.campaigns.setCampaignStatus(failed.campaign.id, "failed");
		expectRefusal(
			() =>
				applyAmendment(h.store, {
					amendment: signedAmendment(failed.digest, (a) => {
						a.appendIssues = [915];
					}),
					nowMs: NOW,
				}),
			"campaign_not_awaiting_approval",
		);

		const h2 = harness();
		const completed = importAndApprove(h2);
		h2.store.campaigns.setCampaignStatus(completed.campaign.id, "completed");
		const result = applyAmendment(h2.store, {
			amendment: signedAmendment(completed.digest, (a) => {
				a.appendIssues = [915];
			}),
			nowMs: NOW,
		});
		expect(result.applied).toBe(true);
		expect((h2.store.campaigns.getCampaign(completed.campaign.id) as CampaignRow).status).toBe(
			"approved",
		);
		expect(h2.store.events.listOpenAttention(completed.campaign.id)).toEqual([]);
	});

	test("invalidates planned never-executed intents and releases their reservations", () => {
		const h = harness();
		const base = importAndApprove(h);
		const campaign = base.campaign;
		const item = h.store.campaigns.listWorkItems(campaign.id)[0] as { id: string };
		// A planned intent from the old version: journaled, never executed.
		const reservation = h.store.budget.reserve({
			campaignId: campaign.id,
			amountUsdCents: 500,
		});
		const planned = h.store.actions.beginAction({
			actionKey: "warren_dispatch:v1:812",
			campaignId: campaign.id,
			workItemId: item.id,
			actionType: "warren_dispatch",
			requestDigest: "a".repeat(64),
			reservedUsdCents: 500,
		});
		// Bind the reservation to the action row it funds.
		h.store.budget.attachReservation(reservation.id, planned.id);

		const result = applyAmendment(h.store, {
			amendment: signedAmendment(base.digest, (a) => {
				a.appendIssues = [915];
			}),
			nowMs: NOW,
		});

		expect(result.invalidatedActionIds).toEqual([planned.id]);
		const settled = h.store.actions.getAction(planned.id) as {
			state: string;
			errorClass: string | null;
		};
		expect(settled.state).toBe("permanent_failure");
		expect(settled.errorClass).toBe("policy_violation");
		const released = h.store.budget.getReservation(reservation.id) as { state: string };
		expect(released.state).toBe("released");
		expect(h.store.events.listOpenAttention(campaign.id)).toEqual([]);
	});
});

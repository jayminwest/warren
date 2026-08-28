/**
 * The runtime-validated V0 campaign manifest schema (plan pl-91b6 step 2,
 * warren-5055).
 *
 * A manifest is immutable operator intent: what upstream repository the
 * campaign contributes to, which bot fork work lands on, the explicit
 * ordered issue list, the warren dispatch identity, spend caps, concurrency,
 * expiry, and the approval envelope. Validation is fail-closed: unknown
 * keys are rejected (so a credential can never ride along — normalization
 * is secret-free by construction), coordinates and refnames follow GitHub
 * grammar, issue ids are unique and ordered, caps are layered per-run ≤
 * daily ≤ total, and the approval digest must recompute exactly over the
 * normalized manifest. Editing any bound field breaks the digest and
 * returns the campaign to awaiting approval.
 */
import { digestOf } from "./digest.ts";
import { ValidationError } from "./errors.ts";
import {
	checkRepoCoordinates,
	isValidRefName,
	REF_GRAMMAR_HINT,
	type RepoCoordinates,
} from "./github-grammar.ts";
import {
	asObject,
	rejectUnknownKeys,
	requireInt,
	requireIsoTimestamp,
	requirePositiveNumber,
	requireSha256,
	requireString,
} from "./validate-utils.ts";

/**
 * Per-issue evidence tiers (warren-4dc1): an optional manifest field mapping
 * an issue number (as a string key) to a declared evidence tier. Issues not
 * listed render as `local-provable`. Membership against the profile's
 * recognized tiers is cross-checked at import (admission), not here — the
 * manifest schema is profile-independent.
 */
export type IssueEvidenceTiers = Record<string, string>;

/** Grammar: `camp-` followed by 3–48 lowercase kebab-case characters. */
const CAMPAIGN_ID = /^camp-[a-z0-9](-?[a-z0-9]){2,47}$/;

/** V0 has exactly one manifest schema revision. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Hard ceiling on the explicit issue list — a campaign is bounded by hand. */
export const MAX_CAMPAIGN_ISSUES = 25;

/** Ceiling on any single USD cap — catch unit mistakes (cents, cents×100). */
export const MAX_CAP_USD = 1000;

/** `owner/repo` pair, already grammar-validated. */
export type { RepoCoordinates } from "./github-grammar.ts";

/** Ordered GitHub issue numbers the campaign may work, in execution order. */
export type IssueId = number;

/** Spend caps, layered per-run ≤ daily ≤ total, all in USD. */
export interface CampaignBudget {
	perRunUsd: number;
	dailyUsd: number;
	totalUsd: number;
}

/** The warren dispatch identity every run of the campaign uses. */
export interface WarrenTarget {
	project: string;
	agent: string;
	provider: string;
	model: string;
}

/** Operator approval bound to the manifest digest. */
export interface ApprovalEnvelope {
	approvedBy: string;
	approvedAt: string;
	manifestDigest: string;
}

/** The normalized, validated V0 campaign manifest. */
export interface CampaignManifest {
	schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
	campaignId: string;
	campaignVersion: number;
	upstream: RepoCoordinates;
	fork: RepoCoordinates;
	defaultBranch: string;
	issues: IssueId[];
	/** Optional per-issue evidence-tier tags (warren-4dc1); unlisted issues are local-provable. */
	issueEvidenceTiers: IssueEvidenceTiers | undefined;
	warren: WarrenTarget;
	prompt: string | undefined;
	promptDigest: string | undefined;
	budget: CampaignBudget;
	maxConcurrentRuns: number;
	expiresAt: string;
	approval: ApprovalEnvelope;
}

/** Validation options: `nowMs` pins "now" so tests stay deterministic. */
export interface ManifestValidationOptions {
	nowMs: number;
}

/** A validated manifest plus the digest its approval binds. */
export interface ValidatedCampaignManifest {
	manifest: CampaignManifest;
	/** digest over the normalized manifest WITHOUT the approval envelope. */
	digest: string;
}

const TOP_LEVEL_FIELDS = [
	"schemaVersion",
	"campaignId",
	"campaignVersion",
	"upstream",
	"fork",
	"defaultBranch",
	"issues",
	"issueEvidenceTiers",
	"warren",
	"prompt",
	"promptDigest",
	"budget",
	"maxConcurrentRuns",
	"expiresAt",
	"approval",
] as const;

const WARREN_FIELDS = ["project", "agent", "provider", "model"] as const;
const BUDGET_FIELDS = ["perRunUsd", "dailyUsd", "totalUsd"] as const;
const APPROVAL_FIELDS = ["approvedBy", "approvedAt", "manifestDigest"] as const;

/**
 * Validate and normalize a campaign manifest. Throws `ValidationError` with
 * an actionable message on any violation. The returned `digest` recomputes
 * over `manifest` minus `approval`, so `approval.manifestDigest` is checked
 * against exactly what later steps would journal.
 */
export function validateCampaignManifest(
	input: unknown,
	options: ManifestValidationOptions,
): ValidatedCampaignManifest {
	const root = asObject(input, "campaign manifest");
	rejectUnknownKeys(root, TOP_LEVEL_FIELDS, "campaign manifest");

	const schemaVersion = requireInt(root, "schemaVersion", "campaign manifest", {
		min: MANIFEST_SCHEMA_VERSION,
		max: MANIFEST_SCHEMA_VERSION,
	});
	const campaignId = requireString(root, "campaignId", "campaign manifest", {
		min: 8,
		max: 54,
		pattern: CAMPAIGN_ID,
		patternHint: "a 'camp-' prefixed lowercase kebab-case id, e.g. camp-2026-08-26-eod-v0",
	});
	const campaignVersion = requireInt(root, "campaignVersion", "campaign manifest", {
		min: 1,
		max: 9999,
	});
	const upstream = requireRepo(root, "upstream");
	const fork = requireRepo(root, "fork");
	if (sameRepo(upstream, fork)) {
		throw new ValidationError(
			"upstream and fork must differ at 'campaign manifest.fork' — the bot fork is a separate repository",
		);
	}
	const defaultBranch = requireBranch(root);
	const issues = requireIssues(root);
	const issueEvidenceTiers = requireIssueEvidenceTiers(root, issues);
	const warren = requireWarren(root);
	const { prompt, promptDigest } = requirePrompt(root);
	const budget = requireBudget(root);
	const maxConcurrentRuns = requireInt(root, "maxConcurrentRuns", "campaign manifest", {
		min: 1,
		max: 10,
	});
	const expiresAt = requireIsoTimestamp(root, "expiresAt", "campaign manifest");
	if (options.nowMs >= Date.parse(expiresAt)) {
		throw new ValidationError(
			`campaign expired: expiresAt '${expiresAt}' is not in the future — an expired manifest cannot be dispatched`,
		);
	}
	const approval = requireApproval(root, options);

	const manifest: CampaignManifest = {
		schemaVersion: schemaVersion as typeof MANIFEST_SCHEMA_VERSION,
		campaignId,
		campaignVersion,
		upstream,
		fork,
		defaultBranch,
		issues,
		issueEvidenceTiers,
		warren,
		prompt,
		promptDigest,
		budget,
		maxConcurrentRuns,
		expiresAt,
		approval,
	};
	const { approval: _bound, ...unapproved } = manifest;
	const digest = digestOf(unapproved);
	if (digest !== approval.manifestDigest) {
		throw new ValidationError(
			`approval digest mismatch at 'campaign manifest.approval.manifestDigest' — expected ${digest} for this manifest content; editing a bound field invalidates approval`,
		);
	}
	return { manifest, digest };
}

function requireRepo(root: ReturnType<typeof asObject>, key: "upstream" | "fork"): RepoCoordinates {
	const coords = checkRepoCoordinates(root[key]);
	if (coords === null) {
		throw new ValidationError(
			`expected a valid GitHub repository {owner, repo} at 'campaign manifest.${key}' — owner is 1–39 ASCII alphanumeric/hyphen characters (no leading/trailing hyphen), repo is 1–100 ASCII alphanumeric/._- characters`,
		);
	}
	return coords;
}

function requireBranch(root: ReturnType<typeof asObject>): string {
	const branch = requireString(root, "defaultBranch", "campaign manifest", {
		min: 1,
		max: 255,
	});
	if (!isValidRefName(branch)) {
		throw new ValidationError(
			`invalid default branch at 'campaign manifest.defaultBranch' — expected ${REF_GRAMMAR_HINT}`,
		);
	}
	return branch;
}

function sameRepo(a: RepoCoordinates, b: RepoCoordinates): boolean {
	return a.owner === b.owner && a.repo === b.repo;
}

function requireIssues(root: ReturnType<typeof asObject>): IssueId[] {
	const raw = root.issues;
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new ValidationError(
			`expected a non-empty ordered array of issue numbers at 'campaign manifest.issues'`,
		);
	}
	if (raw.length > MAX_CAMPAIGN_ISSUES) {
		throw new ValidationError(
			`expected at most ${MAX_CAMPAIGN_ISSUES} issues at 'campaign manifest.issues', got ${raw.length}`,
		);
	}
	const issues: IssueId[] = [];
	const seen = new Set<number>();
	for (const item of raw) {
		if (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > 1_000_000) {
			throw new ValidationError(
				`expected positive integer issue numbers at 'campaign manifest.issues' — campaign work is explicit and ordered`,
			);
		}
		if (seen.has(item)) {
			throw new ValidationError(
				`duplicate issue ${item} at 'campaign manifest.issues' — each issue appears exactly once`,
			);
		}
		seen.add(item);
		issues.push(item);
	}
	return issues;
}

function requireIssueEvidenceTiers(
	root: ReturnType<typeof asObject>,
	issues: readonly IssueId[],
): IssueEvidenceTiers | undefined {
	const raw = root.issueEvidenceTiers;
	if (raw === undefined) return undefined;
	const obj = asObject(raw, "campaign manifest.issueEvidenceTiers");
	const tiers: IssueEvidenceTiers = {};
	for (const [key, value] of Object.entries(obj)) {
		const issue = Number(key);
		if (!Number.isInteger(issue) || !issues.includes(issue)) {
			throw new ValidationError(
				`evidence-tier key "${key}" at 'campaign manifest.issueEvidenceTiers' is not an issue in the manifest's issue list`,
			);
		}
		if (typeof value !== "string" || value.length < 1 || value.length > 64) {
			throw new ValidationError(
				`expected a 1–64 character evidence-tier name at 'campaign manifest.issueEvidenceTiers.${key}'`,
			);
		}
		tiers[key] = value;
	}
	return Object.keys(tiers).length > 0 ? tiers : undefined;
}

function requireWarren(root: ReturnType<typeof asObject>): WarrenTarget {
	const raw = asObject(root.warren, "campaign manifest.warren");
	rejectUnknownKeys(raw, WARREN_FIELDS, "campaign manifest.warren");
	return {
		project: requireString(raw, "project", "campaign manifest.warren", { min: 1, max: 100 }),
		agent: requireString(raw, "agent", "campaign manifest.warren", { min: 1, max: 100 }),
		provider: requireString(raw, "provider", "campaign manifest.warren", { min: 1, max: 100 }),
		model: requireString(raw, "model", "campaign manifest.warren", { min: 1, max: 200 }),
	};
}

function requirePrompt(root: ReturnType<typeof asObject>): {
	prompt: string | undefined;
	promptDigest: string | undefined;
} {
	const prompt = root.prompt;
	const promptDigest = root.promptDigest;
	const hasPrompt = prompt !== undefined;
	const hasDigest = promptDigest !== undefined;
	if (hasPrompt === hasDigest) {
		throw new ValidationError(
			"expected exactly one of 'campaign manifest.prompt' or 'campaign manifest.promptDigest' — a manifest carries the full prompt or a digest of it, never both and never neither",
		);
	}
	if (hasPrompt) {
		if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 65_536) {
			throw new ValidationError(
				"expected a non-empty prompt of at most 65536 characters at 'campaign manifest.prompt'",
			);
		}
		return { prompt, promptDigest: undefined };
	}
	const checked = requireSha256(root, "promptDigest", "campaign manifest");
	return { prompt: undefined, promptDigest: checked };
}

function requireBudget(root: ReturnType<typeof asObject>): CampaignBudget {
	const raw = asObject(root.budget, "campaign manifest.budget");
	rejectUnknownKeys(raw, BUDGET_FIELDS, "campaign manifest.budget");
	const budget: CampaignBudget = {
		perRunUsd: requirePositiveNumber(raw, "perRunUsd", "campaign manifest.budget", MAX_CAP_USD),
		dailyUsd: requirePositiveNumber(raw, "dailyUsd", "campaign manifest.budget", MAX_CAP_USD),
		totalUsd: requirePositiveNumber(raw, "totalUsd", "campaign manifest.budget", MAX_CAP_USD),
	};
	if (budget.perRunUsd > budget.dailyUsd || budget.dailyUsd > budget.totalUsd) {
		throw new ValidationError(
			`caps must layer per-run ≤ daily ≤ total at 'campaign manifest.budget' — got ${budget.perRunUsd} / ${budget.dailyUsd} / ${budget.totalUsd}`,
		);
	}
	return budget;
}

function requireApproval(
	root: ReturnType<typeof asObject>,
	options: ManifestValidationOptions,
): ApprovalEnvelope {
	const raw = asObject(root.approval, "campaign manifest.approval");
	rejectUnknownKeys(raw, APPROVAL_FIELDS, "campaign manifest.approval");
	const approvedAt = requireIsoTimestamp(raw, "approvedAt", "campaign manifest.approval");
	if (Date.parse(approvedAt) > options.nowMs) {
		throw new ValidationError(
			"approval is dated in the future at 'campaign manifest.approval.approvedAt' — approvals cannot predate themselves",
		);
	}
	return {
		approvedBy: requireString(raw, "approvedBy", "campaign manifest.approval", {
			min: 1,
			max: 100,
		}),
		approvedAt,
		manifestDigest: requireSha256(raw, "manifestDigest", "campaign manifest.approval"),
	};
}

// Re-exported for error-message consumers; keeps the grammar hint adjacent
// to the branch validation rather than duplicating the rule text.
export const BRANCH_GRAMMAR_HINT = REF_GRAMMAR_HINT;

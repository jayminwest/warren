/**
 * The runtime-validated V0 repository-policy schema (plan pl-91b6 step 2,
 * warren-5055).
 *
 * A repository policy is a *snapshot* of an upstream repository's
 * contribution rules, pinned to a source URL, fetch time, and content hash.
 * OpenClaw is data here — a committed profile under `data/` — never a
 * conditional in controller code. The policy binds the issue-first
 * requirement, AI-disclosure/evidence requirements, allowed work types,
 * forbidden/protected paths, the upstream open-PR limit, the controller's
 * own stricter caps, required checks, and every mutation flag. In V0 all
 * mutation flags must be present and `false`; a stale snapshot, an
 * over-limit cap, an unknown key, or any enabled mutation fails closed.
 */
import { digestOf } from "./digest.ts";
import { ValidationError } from "./errors.ts";
import { checkRepoCoordinates, type RepoCoordinates } from "./github-grammar.ts";
import {
	EXECUTABLE_MUTATION_FLAGS,
	MUTATION_FLAGS,
	type MutationFlag,
	type Mutations,
	NO_MUTATIONS,
} from "./mutations.ts";
import {
	asObject,
	rejectUnknownKeys,
	requireBoolean,
	requireHttpsUrl,
	requireInt,
	requireIsoTimestamp,
	requireSha256,
	requireString,
	requireStringArray,
} from "./validate-utils.ts";

/** V0 has exactly one repository-policy schema revision. */
export const REPOSITORY_POLICY_SCHEMA_VERSION = 1;

/** Hard ceiling on how old a policy snapshot may declare itself valid. */
export const MAX_STALENESS_DAYS = 365;

/** OpenClaw's own contribution rule caps contributors at 20 open PRs. */
export const OPENCLAW_UPSTREAM_MAX_OPEN_PRS = 20;

/** Work types the V0 controller vocabulary admits. */
export const WORK_TYPES = ["bug-fix", "feature", "docs", "test", "refactor", "chore"] as const;

/** A kind of work a campaign may perform against the upstream repository. */
export type WorkType = (typeof WORK_TYPES)[number];

/** Provenance of the policy snapshot: where, when, and of what content. */
export interface PolicySource {
	url: string;
	fetchedAt: string;
	sha256: string;
}

/** AI contribution disclosure requirements the upstream repository imposes. */
export interface AiDisclosurePolicy {
	required: true;
	evidenceRequired: true;
}

/**
 * Versioned contribution-design norms the policy binds into every dispatch
 * prompt (warren-39b0). Profile data, never controller source: the norms
 * text lives in the repository profile and is covered by the policy digest,
 * so operator approval binds the exact wording.
 */
export interface AgentGuidance {
	/** Guidance-block revision; bumps whenever the norms wording changes. */
	version: number;
	/** Ordered norm strings, rendered verbatim into the dispatch prompt. */
	norms: string[];
}

/**
 * Stable key of one renderable PR-body section (warren-e361). The renderer
 * knows how to fill each key's content; the profile owns the heading, order,
 * and required flag.
 */
export const PR_BODY_SECTION_KEYS = [
	"closes",
	"disclosure",
	"problem",
	"solution",
	"userImpact",
	"evidence",
	"knownGap",
	"responseSummary",
	"runReference",
	"operatorNotes",
] as const;

export type PrBodySectionKey = (typeof PR_BODY_SECTION_KEYS)[number];

/** The standard evidence tiers (warren-4dc1); a profile may declare its own list. */
export const EVIDENCE_TIERS = ["local-provable", "external-proof-required"] as const;

export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/** The tier untagged issues fall back to. */
export const DEFAULT_EVIDENCE_TIER: EvidenceTier = "local-provable";

/** Named template placeholders the renderer can fill (warren-e361). */
export const PR_BODY_PLACEHOLDERS = [
	"campaignId",
	"agent",
	"provider",
	"model",
	"approvedBy",
	"runId",
	"branch",
	"forkOwner",
	"issueNumber",
] as const;

export type PrBodyPlaceholder = (typeof PR_BODY_PLACEHOLDERS)[number];

/** One entry in the profile-declared PR-body section order. */
export interface PrBodySection {
	key: PrBodySectionKey;
	/** Rendered `##` heading, or `null` for a heading-less section. */
	heading: string | null;
	required: boolean;
}

/**
 * Versioned PR-body contract (warren-e361): the profile-owned data behind
 * every rendered pull-request body. Covered by the policy digest, so
 * operator approval binds the exact wording.
 */
export interface PrBodyContract {
	/** Contract revision; bumps whenever the wording or order changes. */
	version: number;
	/** Ordered sections; the renderer walks this list, declaring no headings. */
	sections: PrBodySection[];
	/** AI-disclosure paragraph with named placeholders. */
	disclosureTemplate: string;
	/** Footer paragraph with named placeholders. */
	footerTemplate: string;
}

/** The normalized, validated V0 repository policy. */
export interface RepositoryPolicy {
	schemaVersion: typeof REPOSITORY_POLICY_SCHEMA_VERSION;
	profileId: string;
	upstream: RepoCoordinates;
	source: PolicySource;
	stalenessMaxDays: number;
	issueFirstRequired: true;
	aiDisclosure: AiDisclosurePolicy;
	/** Present when the profile declares it; `null` keeps old profiles valid. */
	agentGuidance: AgentGuidance | null;
	/**
	 * Present when the profile declares it; `null` keeps old profiles valid
	 * and the intender falls back to the shipped default contract
	 * (`profiles/default.pr-body-contract.json`, warren-e361).
	 */
	prBodyContract: PrBodyContract | null;
	/**
	 * The evidence tiers this profile recognizes (warren-4dc1). `null` keeps
	 * old profiles valid and means exactly the standard `EVIDENCE_TIERS`.
	 * Must include `local-provable`, the default tier for untagged issues.
	 */
	evidenceTiers: string[] | null;
	allowedWorkTypes: WorkType[];
	forbiddenPaths: string[];
	protectedPaths: string[];
	upstreamObservedMaxOpenPrs: number;
	maxOpenPrs: number;
	maxNewPrsPerDay: number;
	requiredChecks: string[];
	mutations: Mutations;
}

/** Validation options: `nowMs` pins "now" so tests stay deterministic. */
export interface PolicyValidationOptions {
	nowMs: number;
}

/** A validated policy plus its canonical digest. */
export interface ValidatedRepositoryPolicy {
	policy: RepositoryPolicy;
	digest: string;
}

const TOP_LEVEL_FIELDS = [
	"schemaVersion",
	"profileId",
	"upstream",
	"source",
	"stalenessMaxDays",
	"issueFirstRequired",
	"aiDisclosure",
	"agentGuidance",
	"prBodyContract",
	"evidenceTiers",
	"allowedWorkTypes",
	"forbiddenPaths",
	"protectedPaths",
	"upstreamObservedMaxOpenPrs",
	"maxOpenPrs",
	"maxNewPrsPerDay",
	"requiredChecks",
	"mutations",
] as const;

const SOURCE_FIELDS = ["url", "fetchedAt", "sha256"] as const;
const DISCLOSURE_FIELDS = ["required", "evidenceRequired"] as const;
const AGENT_GUIDANCE_FIELDS = ["version", "norms"] as const;
const PR_BODY_CONTRACT_FIELDS = [
	"version",
	"sections",
	"disclosureTemplate",
	"footerTemplate",
] as const;
const PR_BODY_SECTION_FIELDS = ["key", "heading", "required"] as const;

/** Current PR-body contract revision. */
export const PR_BODY_CONTRACT_VERSION = 1;

/**
 * Fail closed on any `{token}` in a contract template that the renderer
 * cannot fill (warren-e361): an unfilled placeholder would leak a broken
 * literal into the rendered body.
 */
function requireKnownPlaceholders(template: string, path: string): void {
	for (const match of template.matchAll(/\{([A-Za-z]+)\}/g)) {
		if (!PR_BODY_PLACEHOLDERS.includes(match[1] as PrBodyPlaceholder)) {
			throw new ValidationError(
				`unknown placeholder {${match[1]}} at '${path}' — allowed: ${PR_BODY_PLACEHOLDERS.join(", ")}`,
			);
		}
	}
}

/** Validate one `prBodyContract` value (also used on the default-contract load). */
export function validatePrBodyContract(input: unknown, path: string): PrBodyContract {
	const raw = asObject(input, path);
	rejectUnknownKeys(raw, PR_BODY_CONTRACT_FIELDS, path);
	const version = requireInt(raw, "version", path, { min: 1, max: 1_000 });
	const sectionsRaw = raw.sections;
	if (!Array.isArray(sectionsRaw) || sectionsRaw.length === 0) {
		throw new ValidationError(`expected a non-empty array at '${path}.sections'`);
	}
	if (sectionsRaw.length > 20) {
		throw new ValidationError(`expected at most 20 items at '${path}.sections'`);
	}
	const seen = new Set<string>();
	const sections: PrBodySection[] = [];
	for (const entry of sectionsRaw) {
		const item = asObject(entry, `${path}.sections[]`);
		rejectUnknownKeys(item, PR_BODY_SECTION_FIELDS, `${path}.sections[]`);
		const key = requireString(item, "key", `${path}.sections[]`, { min: 1, max: 32 });
		if (!PR_BODY_SECTION_KEYS.includes(key as PrBodySectionKey)) {
			throw new ValidationError(
				`unknown section key "${key}" at '${path}.sections[].key' — allowed: ${PR_BODY_SECTION_KEYS.join(", ")}`,
			);
		}
		if (seen.has(key)) {
			throw new ValidationError(`duplicate section key "${key}" at '${path}.sections[].key'`);
		}
		seen.add(key);
		const heading = item.heading;
		if (heading !== null && typeof heading !== "string") {
			throw new ValidationError(`expected a string or null at '${path}.sections[].heading'`);
		}
		if (typeof heading === "string" && (heading.length === 0 || heading.length > 200)) {
			throw new ValidationError(`expected 1–200 characters at '${path}.sections[].heading'`);
		}
		sections.push({
			key: key as PrBodySectionKey,
			heading,
			required: requireBoolean(item, "required", `${path}.sections[]`),
		});
	}
	const disclosureTemplate = requireString(raw, "disclosureTemplate", path, { min: 1, max: 2_000 });
	requireKnownPlaceholders(disclosureTemplate, `${path}.disclosureTemplate`);
	const footerTemplate = requireString(raw, "footerTemplate", path, { min: 1, max: 2_000 });
	requireKnownPlaceholders(footerTemplate, `${path}.footerTemplate`);
	return { version, sections, disclosureTemplate, footerTemplate };
}

/** Validate the optional profile-declared evidence-tier list (warren-4dc1). */
function requireEvidenceTiers(root: ReturnType<typeof asObject>): string[] | null {
	if (root.evidenceTiers === undefined || root.evidenceTiers === null) {
		return null;
	}
	const raw = root.evidenceTiers;
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16) {
		throw new ValidationError(
			`expected a non-empty array of at most 16 strings at 'repository policy.evidenceTiers'`,
		);
	}
	const tiers: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "string" || item.length < 1 || item.length > 64) {
			throw new ValidationError(
				`expected 1–64 character tier names at 'repository policy.evidenceTiers'`,
			);
		}
		if (seen.has(item)) {
			throw new ValidationError(
				`duplicate evidence tier "${item}" at 'repository policy.evidenceTiers'`,
			);
		}
		seen.add(item);
		tiers.push(item);
	}
	if (!seen.has(DEFAULT_EVIDENCE_TIER)) {
		throw new ValidationError(
			`'repository policy.evidenceTiers' must include "${DEFAULT_EVIDENCE_TIER}" — the default tier for untagged issues`,
		);
	}
	return tiers;
}

function requirePrBodyContract(root: ReturnType<typeof asObject>): PrBodyContract | null {
	if (root.prBodyContract === undefined || root.prBodyContract === null) {
		return null;
	}
	// Optional by design (warren-e361): a previously-valid profile without a
	// contract stays valid and renders through the default contract.
	return validatePrBodyContract(root.prBodyContract, "repository policy.prBodyContract");
}

/**
 * Render the versioned agent-guidance block, clearly delimited, for
 * appending to a dispatched prompt (warren-39b0). Returns `null` when the
 * profile declares no guidance, so the prompt is the base text unchanged.
 */
export function renderAgentGuidance(policy: RepositoryPolicy): string | null {
	const guidance = policy.agentGuidance;
	if (guidance === null) return null;
	const items = guidance.norms.map((norm, index) => `${index + 1}. ${norm}`).join("\n");
	return [
		`--- BEGIN AGENT GUIDANCE (repository policy agentGuidance v${guidance.version}) ---`,
		"The repository policy binds the following contribution norms. They are binding for this run:",
		items,
		"--- END AGENT GUIDANCE ---",
	].join("\n");
}

/**
 * Compose the exact prompt warren receives: the approved base prompt with
 * the profile's agent-guidance block appended. Shared by the initial
 * dispatch and every follow-up dispatch so the norms bind uniformly.
 */
export function composeDispatchPrompt(basePrompt: string, policy: RepositoryPolicy): string {
	const guidance = renderAgentGuidance(policy);
	return guidance === null ? basePrompt : `${basePrompt}\n\n${guidance}`;
}

/**
 * Validate and normalize a repository policy snapshot. Throws
 * `ValidationError` with an actionable message on any violation. Staleness
 * is checked against `options.nowMs`: a snapshot older than
 * `stalenessMaxDays` fails, because no live action may be authorized from
 * stale policy data (design record risk 4).
 */
export function validateRepositoryPolicy(
	input: unknown,
	options: PolicyValidationOptions,
): ValidatedRepositoryPolicy {
	const root = asObject(input, "repository policy");
	rejectUnknownKeys(root, TOP_LEVEL_FIELDS, "repository policy");

	const schemaVersion = requireInt(root, "schemaVersion", "repository policy", {
		min: REPOSITORY_POLICY_SCHEMA_VERSION,
		max: REPOSITORY_POLICY_SCHEMA_VERSION,
	});
	const profileId = requireString(root, "profileId", "repository policy", {
		min: 1,
		max: 64,
	});
	const upstream = requireUpstream(root);
	const stalenessMaxDays = requireInt(root, "stalenessMaxDays", "repository policy", {
		min: 1,
		max: MAX_STALENESS_DAYS,
	});
	const source = requireSource(root, stalenessMaxDays, options);
	const issueFirstRequired = requireBoolean(root, "issueFirstRequired", "repository policy");
	if (!issueFirstRequired) {
		throw new ValidationError(
			"issueFirstRequired must be true at 'repository policy.issueFirstRequired' — V0 only contributes to repositories with an issue-first policy",
		);
	}
	const aiDisclosure = requireAiDisclosure(root);
	const agentGuidance = requireAgentGuidance(root);
	const prBodyContract = requirePrBodyContract(root);
	const evidenceTiers = requireEvidenceTiers(root);
	const allowedWorkTypes = requireWorkTypes(root);
	const forbiddenPaths = requireStringArray(root, "forbiddenPaths", "repository policy", {
		minItems: 1,
		maxItems: 200,
		maxLen: 512,
	});
	const protectedPaths = requireStringArray(root, "protectedPaths", "repository policy", {
		minItems: 0,
		maxItems: 200,
		maxLen: 512,
	});
	const { upstreamObservedMaxOpenPrs, maxOpenPrs, maxNewPrsPerDay } = requirePrLimits(root);
	const requiredChecks = requireStringArray(root, "requiredChecks", "repository policy", {
		minItems: 1,
		maxItems: 50,
		maxLen: 200,
	});
	const mutations = requireMutations(root);

	const policy: RepositoryPolicy = {
		schemaVersion: schemaVersion as typeof REPOSITORY_POLICY_SCHEMA_VERSION,
		profileId,
		upstream,
		source,
		stalenessMaxDays,
		issueFirstRequired: true,
		aiDisclosure,
		agentGuidance,
		prBodyContract,
		evidenceTiers,
		allowedWorkTypes,
		forbiddenPaths,
		protectedPaths,
		upstreamObservedMaxOpenPrs,
		maxOpenPrs,
		maxNewPrsPerDay,
		requiredChecks,
		mutations,
	};
	return { policy, digest: digestOf(policy) };
}

function requireUpstream(root: ReturnType<typeof asObject>): RepoCoordinates {
	const coords = checkRepoCoordinates(root.upstream);
	if (coords === null) {
		throw new ValidationError(
			"expected a valid GitHub repository {owner, repo} at 'repository policy.upstream' — owner is 1–39 ASCII alphanumeric/hyphen characters (no leading/trailing hyphen), repo is 1–100 ASCII alphanumeric/._- characters",
		);
	}
	return coords;
}

function requireSource(
	root: ReturnType<typeof asObject>,
	stalenessMaxDays: number,
	options: PolicyValidationOptions,
): PolicySource {
	const raw = asObject(root.source, "repository policy.source");
	rejectUnknownKeys(raw, SOURCE_FIELDS, "repository policy.source");
	const url = requireHttpsUrl(raw, "url", "repository policy.source");
	const fetchedAt = requireIsoTimestamp(raw, "fetchedAt", "repository policy.source");
	const sha256 = requireSha256(raw, "sha256", "repository policy.source");
	const ageMs = options.nowMs - Date.parse(fetchedAt);
	if (ageMs > stalenessMaxDays * 24 * 60 * 60 * 1000) {
		throw new ValidationError(
			`repository policy snapshot is stale: fetchedAt ${fetchedAt} is older than ${stalenessMaxDays} days — re-fetch and re-approve the policy before any action (repository policy.source.fetchedAt)`,
		);
	}
	return { url, fetchedAt, sha256 };
}

function requireAiDisclosure(root: ReturnType<typeof asObject>): AiDisclosurePolicy {
	const raw = asObject(root.aiDisclosure, "repository policy.aiDisclosure");
	rejectUnknownKeys(raw, DISCLOSURE_FIELDS, "repository policy.aiDisclosure");
	const required = requireBoolean(raw, "required", "repository policy.aiDisclosure");
	const evidenceRequired = requireBoolean(
		raw,
		"evidenceRequired",
		"repository policy.aiDisclosure",
	);
	if (!required || !evidenceRequired) {
		throw new ValidationError(
			"must require both disclosure and evidence at 'repository policy.aiDisclosure' — V0 only contributes where AI-assisted work is disclosed with evidence",
		);
	}
	return { required: true, evidenceRequired: true };
}

function requireAgentGuidance(root: ReturnType<typeof asObject>): AgentGuidance | null {
	if (root.agentGuidance === undefined || root.agentGuidance === null) {
		return null;
	}
	// Optional by design (warren-39b0): a previously-valid profile without a
	// guidance block stays valid. Only a PRESENT block is validated.
	const raw = asObject(root.agentGuidance, "repository policy.agentGuidance");
	rejectUnknownKeys(raw, AGENT_GUIDANCE_FIELDS, "repository policy.agentGuidance");
	const version = requireInt(raw, "version", "repository policy.agentGuidance", {
		min: 1,
		max: 1_000,
	});
	const norms = requireStringArray(raw, "norms", "repository policy.agentGuidance", {
		minItems: 1,
		maxItems: 20,
		maxLen: 512,
	});
	return { version, norms };
}

function requireWorkTypes(root: ReturnType<typeof asObject>): WorkType[] {
	const raw = requireStringArray(root, "allowedWorkTypes", "repository policy", {
		minItems: 1,
		maxItems: WORK_TYPES.length,
		maxLen: 32,
	});
	for (const item of raw) {
		if (!WORK_TYPES.includes(item as WorkType)) {
			throw new ValidationError(
				`unknown work type "${item}" at 'repository policy.allowedWorkTypes' — allowed: ${WORK_TYPES.join(", ")}`,
			);
		}
	}
	return raw as WorkType[];
}

function requirePrLimits(root: ReturnType<typeof asObject>): {
	upstreamObservedMaxOpenPrs: number;
	maxOpenPrs: number;
	maxNewPrsPerDay: number;
} {
	const upstreamObservedMaxOpenPrs = requireInt(
		root,
		"upstreamObservedMaxOpenPrs",
		"repository policy",
		{ min: 1, max: 1000 },
	);
	const maxOpenPrs = requireInt(root, "maxOpenPrs", "repository policy", {
		min: 1,
		max: upstreamObservedMaxOpenPrs,
	});
	const maxNewPrsPerDay = requireInt(root, "maxNewPrsPerDay", "repository policy", {
		min: 1,
		max: maxOpenPrs,
	});
	return { upstreamObservedMaxOpenPrs, maxOpenPrs, maxNewPrsPerDay };
}

function requireMutations(root: ReturnType<typeof asObject>): Mutations {
	const raw = asObject(root.mutations, "repository policy.mutations");
	rejectUnknownKeys(raw, MUTATION_FLAGS, "repository policy.mutations");
	for (const flag of MUTATION_FLAGS) {
		if (!(flag in raw)) {
			throw new ValidationError(
				`missing mutation flag '${flag}' at 'repository policy.mutations' — every flag must be bound explicitly (${MUTATION_FLAGS.join(", ")})`,
			);
		}
	}
	for (const flag of MUTATION_FLAGS) {
		requireBoolean(raw, flag, "repository policy.mutations");
	}
	// Phase 2 (warren-84da) opened `createPullRequest`; Phase 3 (warren-094b)
	// opened the response-loop vocabulary. Every flag outside
	// EXECUTABLE_MUTATION_FLAGS stays schema-refused — the schema change is
	// the reviewable event (§7.1). Each executable flag is individually
	// policy-gated: enabling any one changes the policy digest, so it always
	// requires fresh owner approval.
	const refused = MUTATION_FLAGS.filter(
		(flag) => raw[flag] === true && !EXECUTABLE_MUTATION_FLAGS.includes(flag),
	) as MutationFlag[];
	if (refused.length > 0) {
		throw new ValidationError(
			`mutation flag(s) enabled at 'repository policy.mutations': ${refused.join(", ")} — no executable code path exists for them; only ${EXECUTABLE_MUTATION_FLAGS.join(", ")} may be enabled (warren-84da, warren-094b)`,
		);
	}
	const enabled = EXECUTABLE_MUTATION_FLAGS.filter((flag) => raw[flag] === true);
	if (enabled.length === 0) {
		return NO_MUTATIONS;
	}
	return Object.freeze({
		...NO_MUTATIONS,
		...Object.fromEntries(enabled.map((flag) => [flag, true])),
	} as Record<MutationFlag, boolean>);
}

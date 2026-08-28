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

/** The normalized, validated V0 repository policy. */
export interface RepositoryPolicy {
	schemaVersion: typeof REPOSITORY_POLICY_SCHEMA_VERSION;
	profileId: string;
	upstream: RepoCoordinates;
	source: PolicySource;
	stalenessMaxDays: number;
	issueFirstRequired: true;
	aiDisclosure: AiDisclosurePolicy;
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
			"AI disclosure must require both disclosure and evidence at 'repository policy.aiDisclosure' — V0 only contributes where AI-assisted work is disclosed with evidence",
		);
	}
	return { required: true, evidenceRequired: true };
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

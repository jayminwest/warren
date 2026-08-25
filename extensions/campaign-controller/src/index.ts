/**
 * @warren-ext/campaign-controller entrypoint (placeholder).
 *
 * The V0 controller (plan pl-91b6) will run the dry-run tick loop here:
 * load the approved campaign manifest, reconcile durable state against
 * Warren's public HTTP API and read-only GitHub state, journal every action
 * intent before any I/O, and render (never post) cross-fork pull-request
 * intents. None of that exists yet — this scaffold lands the package
 * boundary, the shared clock/id primitives, and the error base types only.
 *
 * Boundary contract (enforced by the repo's layer guard): this package
 * imports nothing from warren's `src/` or `scripts/`. Everything it knows
 * about warren's wire shapes will be hand-derived here.
 */
export const EXTENSION_NAME = "campaign-controller";
export const EXTENSION_VERSION = "0.0.0";

export {
	type Clock,
	FixedClock,
	type IdGenerator,
	SequentialIdGenerator,
	SystemClock,
	UuidIdGenerator,
} from "./clock.ts";
export {
	canonicalJson,
	digestOf,
	isSha256Hex,
	SHA256_HEX,
	sha256Hex,
} from "./digest.ts";
export {
	BoundaryError,
	CampaignControllerError,
	type CampaignControllerErrorCode,
	ConfigError,
	isCampaignControllerError,
	StateError,
	ValidationError,
} from "./errors.ts";
export {
	checkRepoCoordinates,
	isValidOwner,
	isValidRefName,
	isValidRepo,
	type RepoCoordinates,
} from "./github-grammar.ts";
export {
	type ApprovalEnvelope,
	type CampaignBudget,
	type CampaignManifest,
	type IssueId,
	MANIFEST_SCHEMA_VERSION,
	MAX_CAMPAIGN_ISSUES,
	MAX_CAP_USD,
	type ManifestValidationOptions,
	type ValidatedCampaignManifest,
	validateCampaignManifest,
	type WarrenTarget,
} from "./manifest.ts";
export {
	MUTATION_FLAGS,
	type MutationFlag,
	type Mutations,
	NO_MUTATIONS,
} from "./mutations.ts";
export {
	MAX_STALENESS_DAYS,
	OPENCLAW_UPSTREAM_MAX_OPEN_PRS,
	type PolicySource,
	type PolicyValidationOptions,
	REPOSITORY_POLICY_SCHEMA_VERSION,
	type RepositoryPolicy,
	type ValidatedRepositoryPolicy,
	validateRepositoryPolicy,
	WORK_TYPES,
	type WorkType,
} from "./repository-policy.ts";

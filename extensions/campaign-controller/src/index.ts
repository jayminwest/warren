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
	type AdmissionResult,
	admitWorkItem,
	approveCampaign,
	type CampaignApprovalResult,
	type CampaignImportResult,
	type IssueSnapshot,
	importCampaign,
} from "./admission.ts";
export * from "./admission-errors.ts";
export {
	AMENDMENT_SCHEMA_VERSION,
	type AmendmentApplyResult,
	type AmendmentApproval,
	applyAmendment,
	type CampaignAmendment,
	type ValidatedCampaignAmendment,
	validateCampaignAmendment,
} from "./amendment.ts";
export {
	CliError,
	EXIT_CONFIG_INVALID,
	EXIT_INPUT_INVALID,
	EXIT_OK,
	EXIT_REFUSED,
	EXIT_UPSTREAM,
	EXIT_USAGE,
	exitCodeFor,
} from "./cli/exit-codes.ts";
export { type RunCliOptions, runCli } from "./cli/run.ts";
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
	DISPATCH_UNCERTAIN_REASON,
	type DispatchOutcome,
	type DispatchOutcomeStatus,
	type RestartFailClosedEntry,
	type RestartReconcileResult,
	type RunReconcileResult,
	WARREN_DISPATCH_ACTION_TYPE,
	WarrenDispatcher,
	type WarrenDispatcherDeps,
	type WarrenDispatchRequestSpec,
} from "./dispatch/dispatcher.ts";
export {
	BoundaryError,
	CampaignControllerError,
	type CampaignControllerErrorCode,
	ConfigError,
	isCampaignControllerError,
	StateError,
	ValidationError,
} from "./errors.ts";
export { ReadOnlyGithubClient, type ReadOnlyGithubClientOptions } from "./github/client.ts";
export { type DedupedItems, dedupeByNodeId, filterNewByNodeId } from "./github/dedupe.ts";
export {
	GithubApiError,
	GithubRateLimitError,
	type GithubRateLimitKind,
} from "./github/errors.ts";
export {
	type FakeAbuseState,
	FakeGithubServer,
	type FakeGithubServerOptions,
	type FakeRateLimitState,
	type RecordedGithubRequest,
} from "./github/fake-server.ts";
export {
	assertReadMethod,
	BunFetchGithubTransport,
} from "./github/http-transport.ts";
export {
	BunFetchGithubBranchUpdater,
	BunFetchGithubCommentPoster,
	BunFetchGithubPrUpdater,
	type FollowUpPushIntent,
	type GithubBranchUpdaterTransport,
	type GithubCommentPosterTransport,
	type GithubFollowUpPushTransport,
	GithubMutationUncertainError,
	type GitPushFn,
	GitPushFollowUpPusher,
	type MutationIntent,
	type MutationTransportOptions,
	type PostCommentIntent,
	renderFollowUpPushIntent,
	renderPostCommentIntent,
	renderUpdateBranchIntent,
	renderUpdatePullRequestIntent,
	type UpdateBranchIntent,
	type UpdatePullRequestIntent,
} from "./github/pr-mutations.ts";
export {
	type CrossForkPullRequestIntent,
	type CrossForkPullRequestIntentInput,
	renderCrossForkPullRequestIntent,
} from "./github/pr-request.ts";
export { REDACTED, redactHeaders, redactText, redactValue } from "./github/redact.ts";
export type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubConditionalHeaders,
	GithubContentSnapshot,
	GithubIssueCommentSnapshot,
	GithubIssueSnapshot,
	GithubNoded,
	GithubNotificationSnapshot,
	GithubPageResult,
	GithubPullRequestSnapshot,
	GithubRateSnapshot,
	GithubReadMethod,
	GithubReadRequest,
	GithubReadResult,
	GithubRepoSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
	GithubTransport,
} from "./github/types.ts";
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
	type ExecuteMutationInput,
	executeJournaledMutation,
	FOLLOW_UP_PUSH_ACTION_TYPE,
	type JournalMutationIntentInput,
	type JournalMutationIntentResult,
	journalMutationIntent,
	MUTATION_FAILED_REASON,
	MUTATION_UNCERTAIN_REASON,
	type MutationExecuteOutcome,
	type MutationIoResult,
	mutationRequestDigest,
	POST_COMMENT_ACTION_TYPE,
	UPDATE_BRANCH_ACTION_TYPE,
	UPDATE_PULL_REQUEST_ACTION_TYPE,
} from "./pr-execute/mutation-journal.ts";
export {
	COMMENT_RATE_CAPPED_REASON,
	commentActionKey,
	composeFindingResponseComment,
	composeReReviewComment,
	type PostCommentDeps,
	type PostCommentInput,
	type PostCommentOutcome,
	type PostCommentOutcomeStatus,
	postFindingResponseComment,
	postReReviewCommandComment,
} from "./pr-execute/post-comment.ts";
export {
	PR_INTENT_ACTION_TYPE,
	PR_INTENT_PROTECTED_PATH_REASON,
	type PrIntentInput,
	type PrIntentInvariant,
	type PrIntentIssueFacts,
	type PrIntentMachineJson,
	PrIntentRefusal,
	type PrIntentResult,
	type PrIntentSummaryFacts,
	type PrIntentUpstreamFacts,
	prIntentActionKey,
	prIntentMachineJson,
	renderAndJournalPrIntent,
} from "./pr-intent/intender.ts";
export {
	type AttentionCandidate,
	type AttentionDerivationInput,
	type AttentionReason,
	deriveAttentionCandidates,
} from "./reconcile/attention.ts";
export {
	dedupeEvents,
	type GithubEventKind,
	type NormalizedGithubEvent,
	normalizeCheckRun,
	normalizeCombinedStatus,
	normalizeIssueComment,
	normalizePolicyDigest,
	normalizePullRequest,
	normalizeReview,
	normalizeReviewComment,
} from "./reconcile/events.ts";
export type {
	ReconcileResult,
	UpstreamPrReconcilerDeps,
	UpstreamPrTarget,
} from "./reconcile/reconciler.ts";
export { UpstreamPrReconciler } from "./reconcile/reconciler.ts";
export {
	COMMENT_PLACEHOLDERS,
	type CommentPlaceholder,
	type CommentTemplatesPolicy,
	MAX_STALENESS_DAYS,
	OPENCLAW_UPSTREAM_MAX_OPEN_PRS,
	type PolicySource,
	type PolicyValidationOptions,
	REPOSITORY_POLICY_SCHEMA_VERSION,
	type RepositoryPolicy,
	type ValidatedRepositoryPolicy,
	validateCommentTemplates,
	validateRepositoryPolicy,
	WORK_TYPES,
	type WorkType,
} from "./repository-policy.ts";
export { ActionStore, type SettleActionInput } from "./store/actions.ts";
export { BudgetStore } from "./store/budget.ts";
export { CampaignStore } from "./store/campaigns.ts";
export { EventStore } from "./store/events.ts";
export { LeaseStore } from "./store/leases.ts";
export { MIGRATIONS } from "./store/schema.ts";
export {
	CampaignStateStore,
	type CampaignStateStoreDeps,
	type SchemaColumn,
} from "./store/state-store.ts";
export {
	type ActionErrorClass,
	type ActionRow,
	type ActionState,
	type AmendmentRow,
	type AttentionItemRow,
	type CampaignRow,
	type CampaignStatus,
	type GithubEventRow,
	type LeaseRow,
	type PrIdentityRow,
	type ReservationRow,
	type ReservationState,
	type RunLinkRow,
	TERMINAL_ACTION_STATES,
	type WorkItemRow,
	type WorkItemStatus,
} from "./store/types.ts";
export type {
	TickDeps,
	TickOutcome,
	TickReport,
	TickResult,
	TickStage,
	TickWorkItemSummary,
} from "./tick/tick.ts";
export { runTick, TickConcurrentError } from "./tick/tick.ts";
export {
	DispatchUncertainError,
	isTerminalRunState,
	parseRunEnvelope,
	readTerminalFacts,
	redactSecret,
	WarrenAuthError,
	WarrenClient,
	type WarrenClientOptions,
	type WarrenDispatchInput,
	WarrenEnvelopeError,
	WarrenRateLimitError,
	WarrenRejectedError,
	type WarrenRunView,
	type WarrenTerminalFacts,
	WarrenUnreachableError,
} from "./warren-client.ts";
export { type FakeRunRow, FakeWarrenServer, type RecordedRequest } from "./warren-fake.ts";

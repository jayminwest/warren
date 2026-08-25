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
	BoundaryError,
	CampaignControllerError,
	type CampaignControllerErrorCode,
	ConfigError,
	isCampaignControllerError,
	StateError,
	ValidationError,
} from "./errors.ts";
export {
	ReadOnlyGithubClient,
	type ReadOnlyGithubClientOptions,
} from "./github/client.ts";
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

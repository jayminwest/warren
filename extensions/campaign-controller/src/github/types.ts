/**
 * Transport and wire shapes for the extension-local, structurally read-only
 * GitHub client (plan pl-91b6 step 5, warren-33aa).
 *
 * The transport contract deliberately exposes exactly one operation —
 * `read` — whose method type is `\"GET\" | \"HEAD\"`. There is no write,
 * post, patch, delete, or generic `request` shape anywhere in the
 * production interface; a non-GET/HEAD attempt must fail hard at runtime
 * (BoundaryError), not merely be discouraged by types.
 *
 * Domain snapshots below are *narrowed*: the client parses GitHub's JSON
 * down to exactly these fields and drops everything else, so untrusted
 * upstream payloads can never smuggle fields into controller state
 * (plan risk 5).
 */

/** The only HTTP methods the V0 transport may ever issue. */
export type GithubReadMethod = "GET" | "HEAD";

/** One conditional read request against the GitHub REST surface. */
export interface GithubReadRequest {
	/** Must be GET or HEAD. Anything else fails hard (BoundaryError). */
	method: GithubReadMethod;
	/** Request path starting with `/`, optionally with a query string. */
	path: string;
	/** Extra request headers (conditional reads, Accept types). */
	headers?: Record<string, string>;
}

/** Raw HTTP response as the client sees it. Headers use lowercase keys. */
export interface GithubHttpResponse {
	status: number;
	headers: Record<string, string>;
	/** Raw body text; `null` for HEAD responses or empty bodies. */
	body: string | null;
}

/**
 * The one and only transport operation. Implementations must reject any
 * method other than GET/HEAD before any I/O happens.
 */
export interface GithubTransport {
	read(request: GithubReadRequest): Promise<GithubHttpResponse>;
}

/** Rate-limit facts scraped off response headers. */
export interface GithubRateSnapshot {
	limit: number | null;
	remaining: number | null;
	resetEpochSeconds: number | null;
}

/** Conditional-request validators a caller may replay from a prior read. */
export interface GithubConditionalHeaders {
	etag?: string;
	lastModified?: string;
}

/** Result of one conditional read: either fresh data or a 304 marker. */
export interface GithubReadResult<T> {
	/** True when GitHub answered 304 Not Modified for our validators. */
	notModified: boolean;
	etag: string | null;
	lastModified: string | null;
	rate: GithubRateSnapshot;
	/** Parsed, narrowed data. Undefined when `notModified` is true. */
	data?: T;
}

/** Result of one conditional paginated read. */
export interface GithubPageResult<T> {
	items: T[];
	/** True when the page bound was hit before the collection ended. */
	truncated: boolean;
	/** True when the first page answered 304 Not Modified. */
	notModified: boolean;
	etag: string | null;
	lastModified: string | null;
	rate: GithubRateSnapshot;
}

/** Narrowed repository metadata. */
export interface GithubRepoSnapshot {
	nodeId: string;
	name: string;
	fullName: string;
	ownerLogin: string;
	defaultBranch: string;
	isFork: boolean;
	isArchived: boolean;
	pushedAt: string | null;
	htmlUrl: string;
}

/** Narrowed repository file content (used for CONTRIBUTING reads). */
export interface GithubContentSnapshot {
	path: string;
	encoding: string;
	/** Decoded text content. */
	text: string;
}

/** Narrowed issue metadata. */
export interface GithubIssueSnapshot {
	nodeId: string;
	number: number;
	state: string;
	title: string;
	authorLogin: string;
	labels: string[];
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
	htmlUrl: string;
}

/** Narrowed pull-request metadata. */
export interface GithubPullRequestSnapshot {
	nodeId: string;
	number: number;
	state: string;
	draft: boolean;
	title: string;
	/** Raw PR body text; `null` when GitHub serves none (warren-09d2 divergence checks). */
	body: string | null;
	authorLogin: string;
	headRef: string;
	headSha: string;
	headRepoFullName: string;
	baseRef: string;
	baseSha: string;
	baseRepoFullName: string;
	mergedAt: string | null;
	closedAt: string | null;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
	/**
	 * GitHub's `mergeable_state` rollup (`clean`, `dirty`, `behind`, …),
	 * when the API served it (warren-3d92). `null` means unknown — the
	 * freshness classifier treats unknown as fresh.
	 */
	mergeableState?: string | null;
}

/** Narrowed participating notification (a wake-up, never a command). */
export interface GithubNotificationSnapshot {
	nodeId: string;
	reason: string;
	updatedAt: string;
	subjectType: string;
	subjectTitle: string;
	subjectUrl: string;
	repositoryFullName: string;
}

/** Narrowed issue comment. */
export interface GithubIssueCommentSnapshot {
	nodeId: string;
	id: number;
	authorLogin: string;
	/** GitHub author association (OWNER, MEMBER, CONTRIBUTOR, ...). */
	authorAssociation: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
}

/** Narrowed PR review. */
export interface GithubReviewSnapshot {
	nodeId: string;
	id: number;
	authorLogin: string;
	/** GitHub author association (OWNER, MEMBER, CONTRIBUTOR, ...). */
	authorAssociation: string;
	state: string;
	body: string;
	submittedAt: string | null;
	commitId: string | null;
	htmlUrl: string;
}

/** Narrowed PR review comment (code comment). */
export interface GithubReviewCommentSnapshot {
	nodeId: string;
	id: number;
	authorLogin: string;
	/** GitHub author association (OWNER, MEMBER, CONTRIBUTOR, ...). */
	authorAssociation: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
}

/** Narrowed check run. */
export interface GithubCheckRunSnapshot {
	nodeId: string;
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	startedAt: string | null;
	completedAt: string | null;
	detailsUrl: string | null;
	htmlUrl: string;
}

/** Narrowed combined commit status. */
export interface GithubCombinedStatusSnapshot {
	state: string;
	totalCount: number;
	sha: string;
	contexts: Array<{ context: string; state: string; description: string | null }>;
}

/** Anything the dedupe helper accepts: it must carry a stable node id. */
export interface GithubNoded {
	nodeId: string;
}

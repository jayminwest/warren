/**
 * The HTTP transport under RemoteTracker (warren-d3a9): one JSON client
 * speaking warren-tracker/v1 with the B3/B4 re-derived retry policy —
 *
 *   - 429 / 5xx / network failures retry with exponential backoff
 *     (honoring `Retry-After`, capped so a hostile header cannot stall
 *     boot), then surface as a `TrackerError` carrying the last status.
 *   - Other 4xx are the server's considered answer — no retry.
 *   - `issue_not_found` (the reserved error code) maps onto
 *     `IssueNotFoundError` whatever HTTP status carried it, including at
 *     retry exhaustion: a definitive not-found beats a retry loop.
 *   - `notFoundIsError` (used by getIssue/getPlan) treats any 404 as the
 *     definitive missing-id case.
 *
 * Split from `remote-tracker.ts` for the file-size budget; the protocol
 * vocabulary lives in `./protocol.ts`.
 */

import { IssueNotFoundError, TrackerError } from "../../core/wire.ts";
import { TRACKER_ISSUE_NOT_FOUND_CODE, type TrackerErrorResponse } from "./protocol.ts";

export interface TrackerHttpClientOptions {
	readonly baseUrl: string;
	readonly bearerToken?: string;
	readonly fetchImpl?: typeof fetch;
	/** Max attempts per operation (1 try + retries). Default 4. */
	readonly maxAttempts?: number;
	/** First backoff delay in ms; doubles per retry. Default 250. */
	readonly initialBackoffMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_INITIAL_BACKOFF_MS = 250;
/** Cap a single backoff sleep so a hostile `Retry-After` cannot stall boot. */
const MAX_BACKOFF_MS = 10_000;

/** What the retry loop remembers about the most recent failed attempt. */
interface LastFailure {
	readonly status: number;
	readonly message: string;
	readonly body: TrackerErrorResponse | null;
}

type AttemptOutcome =
	| { readonly kind: "ok"; readonly response: Response }
	| { readonly kind: "retry"; readonly retryAfter: string | null; readonly last: LastFailure }
	| { readonly kind: "final"; readonly error: TrackerError; readonly last: LastFailure };

export class TrackerHttpClient {
	readonly baseUrl: string;
	private readonly bearerToken: string | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly maxAttempts: number;
	private readonly initialBackoffMs: number;

	constructor(options: TrackerHttpClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.bearerToken = options.bearerToken;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
	}

	/** One request with the backoff policy above. */
	async request(
		method: "GET" | "POST",
		path: string,
		options: { body?: unknown; notFoundIsError?: boolean } = {},
	): Promise<Response> {
		const url = `${this.baseUrl}${path}`;
		let last: LastFailure = { status: 0, message: "network failure", body: null };
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			const outcome = await this.attemptOnce(method, url, options);
			if (outcome.kind === "ok") return outcome.response;
			last = outcome.last;
			if (outcome.kind === "retry") {
				await this.sleepBackoff(attempt, outcome.retryAfter);
				continue;
			}
			throw outcome.error;
		}
		if (last.body?.error.code === TRACKER_ISSUE_NOT_FOUND_CODE) {
			throw new IssueNotFoundError(last.body.error.message);
		}
		throw new TrackerError(
			`remote tracker at ${this.baseUrl} failed after ${this.maxAttempts} attempts: ` +
				`last status ${last.status} (${last.message})`,
		);
	}

	/** Classify one fetch attempt as ok / retry / final-error. */
	private async attemptOnce(
		method: "GET" | "POST",
		url: string,
		options: { body?: unknown; notFoundIsError?: boolean },
	): Promise<AttemptOutcome> {
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: {
					accept: "application/json",
					...(options.body !== undefined ? { "content-type": "application/json" } : {}),
					...(this.bearerToken !== undefined
						? { authorization: `Bearer ${this.bearerToken}` }
						: {}),
				},
				...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
			});
		} catch (err) {
			return {
				kind: "retry",
				retryAfter: null,
				last: { status: 0, message: err instanceof Error ? err.message : String(err), body: null },
			};
		}
		if (response.ok) return { kind: "ok", response };
		const body = await this.readErrorBody(response);
		const last: LastFailure = {
			status: response.status,
			message: body?.error.message ?? `HTTP ${response.status}`,
			body,
		};
		if (response.status === 404 && options.notFoundIsError === true) {
			return { kind: "final", error: new IssueNotFoundError(last.message), last };
		}
		if (response.status === 429 || response.status >= 500) {
			return { kind: "retry", retryAfter: response.headers.get("retry-after"), last };
		}
		return { kind: "final", error: this.toError(response.status, body), last };
	}

	private toError(status: number, body: TrackerErrorResponse | null): TrackerError {
		if (body !== null && body.error.code === TRACKER_ISSUE_NOT_FOUND_CODE) {
			return new IssueNotFoundError(body.error.message);
		}
		return new TrackerError(
			`remote tracker at ${this.baseUrl} answered HTTP ${status}: ` +
				`${body?.error.message ?? "no error body"}`,
		);
	}

	private async readErrorBody(response: Response): Promise<TrackerErrorResponse | null> {
		try {
			const parsed = (await response.json()) as Partial<TrackerErrorResponse>;
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				typeof parsed.error === "object" &&
				parsed.error !== null &&
				typeof parsed.error.code === "string" &&
				typeof parsed.error.message === "string"
			) {
				return parsed as TrackerErrorResponse;
			}
		} catch {
			// fall through: a non-JSON error body is not itself an error.
		}
		return null;
	}

	private async sleepBackoff(attempt: number, retryAfter: string | null): Promise<void> {
		let delay = this.initialBackoffMs * 2 ** (attempt - 1);
		if (retryAfter !== null) {
			const seconds = Number(retryAfter);
			if (Number.isFinite(seconds) && seconds >= 0) {
				delay = Math.min(seconds * 1000, MAX_BACKOFF_MS);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(delay, MAX_BACKOFF_MS)));
	}
}

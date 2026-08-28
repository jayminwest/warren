/**
 * Minimal Warren HTTP client for the V0 campaign controller (warren-a732).
 *
 * Hand-derived from warren's published HTTP surface (docs/http-api.md,
 * docs/openapi.yaml) because the extension boundary forbids importing
 * warren's `src/` — everything here mirrors the documented wire shapes only:
 *
 * - `GET /whoami` — credential check.
 * - `POST /runs` — dispatch. Body fields `agent`, `project`, `prompt`,
 *   `providerOverride`, `modelOverride`, `maxCostUsd`; a stable
 *   `Idempotency-Key` header dedupes duplicate deliveries. Returns
 *   `201 {run}` (plus a `sandbox` member this client ignores).
 * - `GET /runs/:id` — detail. Returns `200 {run}`.
 *
 * Failure policy (plan pl-91b6 risk 2): a dispatch POST whose outcome is
 * unknown — network loss after the request was sent, or any 5xx — fails
 * closed as `dispatch_uncertain` and is NEVER retried inside this client,
 * because warren's idempotency store is not durable across restarts and a
 * blind repeat could duplicate paid work. Only safe reads (GET) honor
 * `Retry-After` and retry, on 429/5xx/network, with a bounded attempt count.
 *
 * Secrets: the bearer token exists only in the `Authorization` header. No
 * error message, code, or JSON payload ever embeds it, and the client logs
 * nothing — `redactSecret` exists for callers that must echo foreign text.
 */
import type { Clock } from "./clock.ts";
import { CampaignControllerError, StateError, ValidationError } from "./errors.ts";

/** Injectable fetch shape; the production default is the global `fetch`. */
export type FetchLike = (
	url: string,
	init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
) => Promise<Response>;

/** Hand-derived subset of warren's `RunRow` the controller consumes. */
export interface WarrenRunView {
	id: string;
	state: string;
	failureReason: string | null;
	/** Dispatch-supplied git ref the workspace was cloned from. */
	ref: string | null;
	/** Branch the reap path pushes the workspace back to. */
	targetBranch: string | null;
	/**
	 * Composed workspace branch frozen at dispatch (warren-5255):
	 * `${runBranchPrefix}/${runId}`, or the targetBranch override. Null on
	 * warren instances or run rows predating the column.
	 */
	branch: string | null;
	provider: string | null;
	model: string | null;
	costUsd: number | null;
}

/**
 * The branch the run's push actually landed on: the dispatch-frozen
 * `branch` when warren serves it (warren-5255), else the operator
 * `targetBranch` override, else unknown. Never derives the prefix
 * composition locally — that is warren's own single source of truth.
 */
export function runPushedBranch(run: {
	branch: string | null;
	targetBranch: string | null;
}): string | null {
	return run.branch ?? run.targetBranch;
}

/** Terminal-state facts reconciliation (pl-91b6 step 7) reads. */
export interface WarrenTerminalFacts {
	runId: string;
	state: string;
	failureReason: string | null;
	ref: string | null;
	targetBranch: string | null;
	branch: string | null;
	costUsd: number | null;
}

/** One explicit issue-derived dispatch onto warren. */
export interface WarrenDispatchInput {
	project: string;
	agent: string;
	prompt: string;
	provider?: string;
	model?: string;
	maxCostUsd?: number;
	/** Dispatch onto this existing branch instead of a fresh workspace branch (warren-326f). */
	existingBranch?: string;
	/** Required, stable, and caller-owned; a repeat delivery must reuse it. */
	idempotencyKey: string;
}

export interface WarrenClientOptions {
	baseUrl: string;
	/** Bearer credential; only ever travels in the Authorization header. */
	token: string;
	fetchFn?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	clock?: Clock;
	/** Bounded retry attempts for SAFE reads only. Default 3. */
	maxReadRetries?: number;
}

/** Credential rejected by warren (401/403). */
export class WarrenAuthError extends CampaignControllerError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("warren_auth_rejected", message, options);
		this.name = "WarrenAuthError";
	}
}

/** A considered (non-retryable) 4xx from warren. */
export class WarrenRejectedError extends CampaignControllerError {
	readonly status: number;
	readonly warrenCode: string | null;
	constructor(status: number, warrenCode: string | null, message: string) {
		super("warren_rejected", message);
		this.name = "WarrenRejectedError";
		this.status = status;
		this.warrenCode = warrenCode;
	}
}

/** 429 — retryable by the caller; `retryAfterMs` carries parsed Retry-After. */
export class WarrenRateLimitError extends CampaignControllerError {
	readonly retryAfterMs: number | null;
	constructor(retryAfterMs: number | null, message: string) {
		super("warren_rate_limited", message);
		this.name = "WarrenRateLimitError";
		this.retryAfterMs = retryAfterMs;
	}
}

/** Safe-read transport exhausted retries (network/5xx). */
export class WarrenUnreachableError extends CampaignControllerError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("warren_unreachable", message, options);
		this.name = "WarrenUnreachableError";
	}
}

/** 2xx body was not the documented `{run}` envelope. */
export class WarrenEnvelopeError extends CampaignControllerError {
	constructor(message: string) {
		super("warren_envelope_invalid", message);
		this.name = "WarrenEnvelopeError";
	}
}

/** Dispatch outcome unknown — fail closed, never auto-retried. */
export class DispatchUncertainError extends CampaignControllerError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("dispatch_uncertain", message, options);
		this.name = "DispatchUncertainError";
	}
}

const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

/** Is this warren run state terminal? Hand-derived from warren's wire set. */
export function isTerminalRunState(state: string): boolean {
	return TERMINAL_RUN_STATES.has(state);
}

/** Replace any occurrence of a secret in foreign text before echoing it. */
export function redactSecret(text: string, secret: string): string {
	if (secret.length === 0) {
		return text;
	}
	return text.split(secret).join("[redacted]");
}

/** Parse a Retry-After header (delay-seconds or HTTP-date) into ms. */
function retryAfterMs(header: string | null, clock: Clock): number | null {
	if (header === null || header === "") {
		return null;
	}
	const seconds = Number.parseInt(header, 10);
	if (Number.isFinite(seconds) && String(seconds) === header.trim()) {
		return Math.max(0, seconds * 1000);
	}
	const dateMs = Date.parse(header);
	if (Number.isFinite(dateMs)) {
		return Math.max(0, dateMs - clock.nowMs());
	}
	return null;
}

interface ErrorEnvelopeShape {
	error?: { code?: unknown; message?: unknown };
}

async function readErrorEnvelope(res: Response): Promise<{ code: string | null; message: string }> {
	try {
		const body = (await res.json()) as ErrorEnvelopeShape;
		const err = body?.error;
		if (typeof err?.message === "string") {
			return {
				code: typeof err.code === "string" ? err.code : null,
				message: err.message,
			};
		}
	} catch {
		/* fall through to the status line */
	}
	return { code: null, message: `warren responded ${res.status}` };
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Parse the documented `{run}` envelope off a 2xx body. */
export function parseRunEnvelope(raw: unknown): WarrenRunView {
	if (typeof raw !== "object" || raw === null || !("run" in raw)) {
		throw new WarrenEnvelopeError("response body is not a {run} envelope");
	}
	const run = (raw as { run: unknown }).run;
	if (typeof run !== "object" || run === null) {
		throw new WarrenEnvelopeError("envelope member 'run' is not an object");
	}
	const row = run as Record<string, unknown>;
	if (typeof row.id !== "string" || row.id === "") {
		throw new WarrenEnvelopeError("run envelope is missing a string 'id'");
	}
	if (typeof row.state !== "string" || row.state === "") {
		throw new WarrenEnvelopeError(`run ${row.id} envelope is missing a string 'state'`);
	}
	return {
		id: row.id,
		state: row.state,
		failureReason: asString(row.failureReason),
		ref: asString(row.ref),
		targetBranch: asString(row.targetBranch),
		branch: asString(row.branch),
		provider: asString(row.provider),
		model: asString(row.model),
		costUsd: typeof row.costUsd === "number" ? row.costUsd : null,
	};
}

/**
 * Terminal branch/ref/outcome/cost facts. Throws `StateError` when the run
 * is not terminal yet, so reconciliation never reads a half-finished run as
 * settled.
 */
export function readTerminalFacts(run: WarrenRunView): WarrenTerminalFacts {
	if (!isTerminalRunState(run.state)) {
		throw new StateError(`run ${run.id} is not terminal yet (state: ${run.state})`);
	}
	return {
		runId: run.id,
		state: run.state,
		failureReason: run.failureReason,
		ref: run.ref,
		targetBranch: run.targetBranch,
		branch: run.branch,
		costUsd: run.costUsd,
	};
}

/** The minimal Warren HTTP client for V0. */
export class WarrenClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchFn: FetchLike;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly clock: Clock;
	private readonly maxReadRetries: number;

	constructor(options: WarrenClientOptions) {
		if (!options.token) {
			throw new ValidationError("warren token is required");
		}
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.token = options.token;
		this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
		this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.clock = options.clock ?? {
			nowMs: () => Date.now(),
		};
		this.maxReadRetries = options.maxReadRetries ?? 3;
	}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}` };
	}

	/** Verify the credential without ever logging it. */
	async verifyCredential(): Promise<{ identity: string }> {
		let res: Response;
		try {
			res = await this.fetchFn(`${this.baseUrl}/whoami`, {
				method: "GET",
				headers: this.headers(),
			});
		} catch (cause) {
			throw new WarrenUnreachableError("warren is unreachable (GET /whoami)", { cause });
		}
		if (res.status === 401 || res.status === 403) {
			throw new WarrenAuthError(`warren rejected the credential (HTTP ${res.status})`);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new WarrenRejectedError(res.status, null, `GET /whoami failed (HTTP ${res.status})`);
		}
		try {
			const body = (await res.json()) as { identity?: unknown };
			if (typeof body?.identity !== "string") {
				throw new WarrenEnvelopeError("whoami response is missing a string 'identity'");
			}
			return { identity: body.identity };
		} catch (cause) {
			if (cause instanceof WarrenEnvelopeError) {
				throw cause;
			}
			throw new WarrenEnvelopeError("whoami response body is not JSON");
		}
	}

	/**
	 * Dispatch one run. Never retried by this client: any ambiguous outcome
	 * (network loss after send, 5xx) fails closed as `DispatchUncertainError`.
	 */
	async dispatchRun(input: WarrenDispatchInput): Promise<WarrenRunView> {
		const key = input.idempotencyKey.trim();
		if (key === "") {
			throw new ValidationError("idempotencyKey is required for dispatch");
		}
		const body = JSON.stringify({
			agent: input.agent,
			project: input.project,
			prompt: input.prompt,
			...(input.provider !== undefined ? { providerOverride: input.provider } : {}),
			...(input.model !== undefined ? { modelOverride: input.model } : {}),
			...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
			...(input.existingBranch !== undefined ? { existingBranch: input.existingBranch } : {}),
		});
		let res: Response;
		try {
			res = await this.fetchFn(`${this.baseUrl}/runs`, {
				method: "POST",
				headers: { ...this.headers(), "Content-Type": "application/json", "Idempotency-Key": key },
				body,
			});
		} catch (cause) {
			throw new DispatchUncertainError(
				"network error after the dispatch request was sent; the run may or may not exist",
				{ cause },
			);
		}
		if (res.status === 429) {
			// Rejected before acceptance — unambiguous, so the caller may retry.
			throw new WarrenRateLimitError(
				retryAfterMs(res.headers.get("Retry-After"), this.clock),
				"warren rate-limited the dispatch before accepting it",
			);
		}
		if (res.status >= 500) {
			throw new DispatchUncertainError(
				`warren returned HTTP ${res.status} for the dispatch; the run may or may not exist`,
			);
		}
		if (res.status === 401 || res.status === 403) {
			throw new WarrenAuthError(`warren rejected the credential (HTTP ${res.status})`);
		}
		if (res.status < 200 || res.status >= 300) {
			const err = await readErrorEnvelope(res);
			throw new WarrenRejectedError(res.status, err.code, `dispatch rejected: ${err.message}`);
		}
		return parseRunEnvelope(await this.safeJson(res));
	}

	/** Fetch run detail. Safe read: retries 429/5xx/network honoring Retry-After. */
	async getRun(id: string): Promise<WarrenRunView> {
		let attempt = 0;
		for (;;) {
			const outcome = await this.attemptGetRun(id);
			if (outcome.run !== undefined) {
				return outcome.run;
			}
			if (!outcome.retryable || attempt >= this.maxReadRetries) {
				throw outcome.failure ?? new WarrenUnreachableError(`GET /runs/${id} failed`);
			}
			await this.backOff(outcome.retryAfterMs ?? null, attempt);
			attempt += 1;
		}
	}

	/** One read attempt: either a parsed run or the failure the retry loop acts on. */
	private async attemptGetRun(id: string): Promise<{
		run?: WarrenRunView;
		failure?: CampaignControllerError;
		retryAfterMs?: number | null;
		retryable: boolean;
	}> {
		let res: Response;
		try {
			res = await this.fetchFn(`${this.baseUrl}/runs/${encodeURIComponent(id)}`, {
				method: "GET",
				headers: this.headers(),
			});
		} catch (cause) {
			return {
				failure: new WarrenUnreachableError(`GET /runs/${id} failed`, { cause }),
				retryable: true,
			};
		}
		if (res.status === 429 || res.status >= 500) {
			return {
				failure: this.readFailure(res),
				retryAfterMs: retryAfterMs(res.headers.get("Retry-After"), this.clock),
				retryable: true,
			};
		}
		if (res.status === 401 || res.status === 403) {
			return {
				failure: new WarrenAuthError(`warren rejected the credential (HTTP ${res.status})`),
				retryable: false,
			};
		}
		if (res.status < 200 || res.status >= 300) {
			const err = await readErrorEnvelope(res);
			return {
				failure: new WarrenRejectedError(res.status, err.code, `GET run rejected: ${err.message}`),
				retryable: false,
			};
		}
		return { run: parseRunEnvelope(await this.safeJson(res)), retryable: false };
	}

	private async backOff(retryAfterMs: number | null, attempt: number): Promise<void> {
		const fallbackMs = 100 * 2 ** attempt;
		await this.sleep(retryAfterMs ?? fallbackMs);
	}

	private readFailure(res: Response): CampaignControllerError {
		if (res.status === 429) {
			return new WarrenRateLimitError(
				retryAfterMs(res.headers.get("Retry-After"), this.clock),
				"warren kept rate-limiting the read",
			);
		}
		return new WarrenUnreachableError(`warren returned HTTP ${res.status} for the read`);
	}

	private async safeJson(res: Response): Promise<unknown> {
		try {
			return await res.json();
		} catch {
			throw new WarrenEnvelopeError("response body is not JSON");
		}
	}
}

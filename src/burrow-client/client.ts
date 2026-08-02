/**
 * BurrowClient — warren's facade over `@os-eco/burrow-cli`'s HttpClient.
 *
 * The thin wrapper is mostly a construction helper plus a connection
 * probe. The real surface (burrows / runs / inbox / events / agents
 * namespaces) is forwarded straight from `HttpClient`; warren's own
 * HTTP API maps onto those routes 1:1 (docs/http-api.md) so adding a layer
 * of warren-specific methods would just produce noise.
 *
 * What the facade *does* add:
 *   1. Env-driven construction (`fromEnv`) so the warren process and
 *      its tests don't repeat transport-resolution logic.
 *   2. `probe()` — a healthz call wrapped in a timeout that converts
 *      transport-layer fetch failures (socket missing, ECONNREFUSED,
 *      timeout) into `BurrowUnreachableError`. Used by `/readyz`,
 *      `warren doctor`, and any startup path that needs to know
 *      whether burrow is reachable before continuing.
 *   3. Wire-error mapping — `withTransportMapping` runs an HttpClient
 *      call and rethrows transport-layer errors as the structured
 *      `BurrowUnreachableError`. Wrap calls in the docs/design/agent-composition.md composition flows
 *      where a unreachable burrow should turn into a 503 from warren
 *      rather than a stack trace.
 *
 * What it deliberately does *not* add:
 *   - No retry/backoff loop. Idempotency is per-route (burrow's
 *     concern), and warren's run lifecycle wants explicit failure not
 *     hidden retry. Add at the call site if needed.
 *   - No request logging here. The warren HTTP server logs at the
 *     route boundary; logging both would double up.
 *   - No higher-level types. The docs/design/agent-composition.md spawn flow constructs its own
 *     domain types from `Burrow` / `Run`; this client returns burrow's
 *     wire types untouched.
 */

import {
	type Burrow,
	NotFoundError as BurrowNotFoundError,
	ValidationError as BurrowValidationError,
	CredentialError,
	type HttpBurrowUpInput,
	HttpClient,
	HttpClientError,
	type HttpClientOptions,
} from "@os-eco/burrow-cli";
import { type BurrowClientConfig, type EnvLike, loadBurrowClientConfigFromEnv } from "./config.ts";
import { BurrowUnreachableError } from "./errors.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export interface BurrowClientOptions {
	readonly config: BurrowClientConfig;
	/** Override fetch (tests, instrumentation). Forwarded to the HttpClient. */
	readonly fetch?: typeof fetch;
}

export class BurrowClient {
	readonly http: HttpClient;
	readonly config: BurrowClientConfig;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: BurrowClientOptions) {
		this.config = opts.config;
		this.fetchImpl = opts.fetch ?? fetch;
		const httpOpts: HttpClientOptions = { transport: opts.config.transport };
		if (opts.config.token !== undefined) httpOpts.token = opts.config.token;
		if (opts.fetch !== undefined) httpOpts.fetch = opts.fetch;
		this.http = new HttpClient(httpOpts);
	}

	static fromEnv(env: EnvLike = process.env, fetchImpl?: typeof fetch): BurrowClient {
		const config = loadBurrowClientConfigFromEnv(env);
		return new BurrowClient(fetchImpl !== undefined ? { config, fetch: fetchImpl } : { config });
	}

	/**
	 * Hit `/healthz` with a timeout and convert transport-layer failures
	 * into `BurrowUnreachableError`. Auth-protected routes are not
	 * exercised here — `/healthz` is auth-exempt by burrow's contract,
	 * so a successful probe means the socket is up but says nothing
	 * about token correctness. Use a real call (e.g. `burrows.list`)
	 * for an auth-aware liveness check.
	 */
	async probe(timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): Promise<void> {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			await withTransportMapping(this.config, async () => {
				// HttpClient.healthz has no signal hook, so race against the timer
				// via Promise.race — abort still fires on the underlying fetch
				// because Bun propagates AbortSignal through the global `fetch`
				// when one is installed via setTimeout. Without that, the
				// timeout still wins because the race resolves first; the
				// outstanding fetch is GC'd when the response stream is dropped.
				const aborted = new Promise<never>((_, reject) => {
					ctrl.signal.addEventListener(
						"abort",
						() => reject(new BurrowUnreachableError(`burrow probe timed out after ${timeoutMs}ms`)),
						{ once: true },
					);
				});
				await Promise.race([this.http.healthz(), aborted]);
			});
		} finally {
			clearTimeout(timer);
		}
	}

	async close(): Promise<void> {
		await this.http.close();
	}

	/**
	 * Flip the burrow worker's admin drain bit (warren-0f0c / pl-9ba1 step 6).
	 * `POST /admin/drain` on the burrow side rejects new `POST /burrows` and
	 * `POST /burrows/:id/runs` with a 503 `worker_draining`; in-flight runs
	 * and read endpoints keep working so warren can still observe the
	 * worker's terminal state. See burrow's `src/server/admin.ts`.
	 *
	 * `HttpClient` does not expose the admin namespace, so we hand-roll the
	 * request against the same transport (unix socket / TCP + bearer token)
	 * the rest of the client uses. Transport-layer failures rethrow as
	 * `BurrowUnreachableError` so warren's HTTP layer returns 503 with a
	 * structured envelope; server-side error envelopes (e.g. an older
	 * burrow without `/admin/drain` returning 404 `not_found`) pass through
	 * as the rehydrated `BurrowError` subclass.
	 */
	/**
	 * Provision a burrow with optional per-run env injection (warren-e26f).
	 *
	 * Delegates to `http.burrows.up` when no env is supplied — that path is
	 * the source of truth for field allowlisting and error rehydration.
	 * When `env` is set, build the body manually and POST directly: burrow's
	 * `HttpBurrowsClient.up` allowlists known fields and silently drops the
	 * rest, so it can't carry per-run env vars forward. Plot integration
	 * (warren-000b / pl-2047 step 4) uses this path to forward
	 * `PLOT_ID` / `PLOT_ACTOR` to the sandbox.
	 *
	 * Error rehydration mirrors burrow's own `rehydrateError` table for the
	 * codes burrow's `up` route actually emits (validation_error,
	 * not_found, credential_error, …); everything else falls through to
	 * `HttpClientError` so warren's `renderError` still tags it correctly.
	 */
	async burrowsUp(input: HttpBurrowUpInput & { env?: Record<string, string> }): Promise<Burrow> {
		if (input.env === undefined) {
			return this.http.burrows.up(input);
		}
		return withTransportMapping(this.config, async () => {
			const body: Record<string, unknown> = { projectRoot: input.projectRoot };
			if (input.name !== undefined) body.name = input.name;
			if (input.branch !== undefined) body.branch = input.branch;
			if (input.baseBranch !== undefined) body.baseBranch = input.baseBranch;
			if (input.originUrl !== undefined) body.originUrl = input.originUrl;
			if (input.network !== undefined) body.network = input.network;
			if (input.provider !== undefined) body.provider = input.provider;
			if (input.agents !== undefined) body.agents = [...input.agents];
			if (input.seed !== undefined) {
				body.seed = { files: input.seed.files.map((f) => ({ ...f })) };
			}
			body.env = { ...input.env };

			const url = buildBurrowsUrl(this.config);
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (this.config.token !== undefined) headers.authorization = `Bearer ${this.config.token}`;
			const init: RequestInit & { unix?: string } = {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			};
			if (this.config.transport.kind === "unix") init.unix = this.config.transport.path;
			const res = await this.fetchImpl(url, init);
			if (!res.ok) {
				throw await rehydrateBurrowsUpError(res);
			}
			const raw = (await res.json()) as Record<string, unknown>;
			return reviveBurrow(raw);
		});
	}

	async setDrain(drain: boolean): Promise<{ drain: boolean }> {
		return withTransportMapping(this.config, async () => {
			const url = buildAdminUrl(this.config);
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (this.config.token !== undefined) headers.authorization = `Bearer ${this.config.token}`;
			const init: RequestInit & { unix?: string } = {
				method: "POST",
				headers,
				body: JSON.stringify({ drain }),
			};
			if (this.config.transport.kind === "unix") init.unix = this.config.transport.path;
			const res = await this.fetchImpl(url, init);
			if (!res.ok) {
				throw await rehydrateAdminError(res);
			}
			return (await res.json()) as { drain: boolean };
		});
	}
}

function buildBurrowsUrl(config: BurrowClientConfig): string {
	const base =
		config.transport.kind === "unix"
			? "http://localhost"
			: `http://${config.transport.hostname}:${config.transport.port}`;
	return `${base}/burrows`;
}

/**
 * Rehydrate a non-2xx response from `POST /burrows` into the same error
 * shapes `HttpClient.burrows.up` would throw. Codes not in the table fall
 * through to `HttpClientError` so warren's `renderError` still maps them.
 */
async function rehydrateBurrowsUpError(res: Response): Promise<Error> {
	let envelope: AdminErrorEnvelope | null = null;
	try {
		envelope = (await res.json()) as AdminErrorEnvelope;
	} catch {
		// Non-JSON body — fall through to a generic HttpClientError below.
	}
	const code = envelope?.error?.code ?? "internal_error";
	const message = envelope?.error?.message ?? `burrow POST /burrows returned HTTP ${res.status}`;
	const hint = envelope?.error?.hint;
	const opts = hint !== undefined ? { recoveryHint: hint } : undefined;
	switch (code) {
		case "not_found":
			return new BurrowNotFoundError(message, opts);
		case "validation_error":
			return new BurrowValidationError(message, opts);
		case "credential_error":
			return new CredentialError(message, opts);
		default:
			return new HttpClientError(res.status, code, message, hint);
	}
}

interface BurrowRowDates {
	createdAt: unknown;
	updatedAt: unknown;
	destroyedAt: unknown;
}

/**
 * Mirror of burrow-cli's internal `reviveBurrow`: turn ISO date strings
 * coming over the wire back into `Date` instances. Kept local to the
 * `burrowsUp` direct-fetch path so we don't depend on a non-exported
 * helper from `@os-eco/burrow-cli`.
 */
function reviveBurrow(raw: Record<string, unknown>): Burrow {
	const row = raw as Record<string, unknown> & BurrowRowDates;
	return {
		...row,
		createdAt: toDate(row.createdAt),
		updatedAt: toDate(row.updatedAt),
		destroyedAt:
			row.destroyedAt === null || row.destroyedAt === undefined ? null : toDate(row.destroyedAt),
	} as Burrow;
}

function toDate(value: unknown): Date {
	if (value instanceof Date) return value;
	if (typeof value === "string") return new Date(value);
	if (typeof value === "number") return new Date(value);
	throw new Error(`burrowsUp: expected date-like value, got ${typeof value}`);
}

function buildAdminUrl(config: BurrowClientConfig): string {
	const base =
		config.transport.kind === "unix"
			? "http://localhost"
			: `http://${config.transport.hostname}:${config.transport.port}`;
	return `${base}/admin/drain`;
}

/**
 * Re-shape a non-2xx response from `/admin/drain` into the same shape
 * `HttpClient`'s namespaces throw. `@os-eco/burrow-cli` does not export
 * its private `rehydrateError`, so we cover the codes the admin endpoint
 * can plausibly emit (not_found, validation_error, credential_error) and
 * fall through to the public `HttpClientError` for everything else.
 * Warren's `renderError` (`src/server/errors.ts`) already maps each of
 * these.
 */
interface AdminErrorEnvelope {
	error?: { code?: string; message?: string; hint?: string };
}

async function rehydrateAdminError(res: Response): Promise<Error> {
	let envelope: AdminErrorEnvelope | null = null;
	try {
		envelope = (await res.json()) as AdminErrorEnvelope;
	} catch {
		// Non-JSON body — fall through to a generic HttpClientError below.
	}
	const code = envelope?.error?.code ?? "internal_error";
	const message = envelope?.error?.message ?? `burrow /admin/drain returned HTTP ${res.status}`;
	const hint = envelope?.error?.hint;
	const opts = hint !== undefined ? { recoveryHint: hint } : undefined;
	switch (code) {
		case "not_found":
			return new BurrowNotFoundError(message, opts);
		case "validation_error":
			return new BurrowValidationError(message, opts);
		case "credential_error":
			return new CredentialError(message, opts);
		default:
			return new HttpClientError(res.status, code, message, hint);
	}
}

/**
 * Convert raw `fetch` failures into `BurrowUnreachableError` while
 * letting `BurrowError` (from the rehydrated server envelope) and
 * other structured errors pass through.
 */
export async function withTransportMapping<T>(
	config: BurrowClientConfig,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof BurrowUnreachableError) throw err;
		if (isTransportError(err)) {
			throw new BurrowUnreachableError(formatTransportError(config, err), { cause: err });
		}
		throw err;
	}
}

/**
 * A "transport error" is any error that isn't a structured response
 * from burrow's server. The HttpClient throws either:
 *   - `BurrowError` subclasses (server returned an error envelope), or
 *   - `HttpClientError` (server returned a recognized but unmapped code), or
 *   - whatever `fetch` rejects with when the request itself failed
 *     (socket missing, ECONNREFUSED, name resolution, abort).
 *
 * The first two carry a `.name` of `BurrowError` / `HttpClientError`.
 * Anything else here is by elimination a transport problem. We also
 * peek at the cause chain because Bun wraps lower-level errors in a
 * `TypeError: fetch failed` whose `.cause` carries the real `code`.
 */
export function isTransportError(err: unknown): err is Error {
	if (!(err instanceof Error)) return false;
	if (err.name === "BurrowError" || err.name === "HttpClientError") return false;
	// Walk parent error classes — every `BurrowError` subclass overrides `.name`.
	let cur: object | null = Object.getPrototypeOf(err) as object | null;
	while (cur !== null) {
		const proto = cur as { constructor?: { name?: string } };
		const n = proto.constructor?.name;
		if (n === "BurrowError" || n === "HttpClientError" || n === "WarrenError") return false;
		cur = Object.getPrototypeOf(cur) as object | null;
	}
	return true;
}

function formatTransportError(config: BurrowClientConfig, err: Error): string {
	const where =
		config.transport.kind === "unix"
			? `unix:${config.transport.path}`
			: `tcp://${config.transport.hostname}:${config.transport.port}`;
	const cause = extractCauseCode(err);
	return cause !== null
		? `burrow unreachable at ${where} (${cause})`
		: `burrow unreachable at ${where}: ${err.message}`;
}

function extractCauseCode(err: unknown): string | null {
	let cur: unknown = err;
	for (let i = 0; i < 5 && cur !== null && cur !== undefined; i++) {
		if (typeof cur === "object") {
			const obj = cur as { code?: unknown; cause?: unknown };
			if (typeof obj.code === "string") return obj.code;
			cur = obj.cause;
			continue;
		}
		break;
	}
	return null;
}

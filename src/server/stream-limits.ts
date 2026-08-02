/**
 * Concurrent event-stream admission (warren-25f6).
 *
 * `GET /runs/:id/events?follow=1` and `GET /plan-runs/:id/events?follow=1`
 * hold a connection open for the whole life of a run, and `startServer`
 * disables Bun's per-request idle timeout server-wide so a quiet agent
 * doesn't get its stream reaped (warren-b8fc). The control plane is a
 * single replica by construction — SSE stickiness plus an RWO volume — so
 * without a cap those two routes are an unbounded connection-exhaustion
 * lever. A front-page link reaches it without anyone meaning harm.
 *
 * Two in-process counters (a shared store would buy nothing against one
 * replica):
 *
 *   - **per-client** (`WARREN_MAX_EVENT_STREAMS_PER_CLIENT`, default 5) —
 *     bounds one browser / script. Checked FIRST so the rejection names the
 *     actual offender rather than blaming the instance. The client key is
 *     derived from `X-Forwarded-For` counting RIGHT from the trusted edge
 *     (`WARREN_EVENT_STREAM_TRUSTED_PROXY_HOPS`), never the client-forgeable
 *     left-most hop — see `eventStreamClientKey` (warren-46a7).
 *   - **global** (`WARREN_MAX_EVENT_STREAMS`, default 200) — bounds the
 *     instance. Logged at `warn`: an instance at its stream cap is an
 *     operator signal, not routine.
 *
 * Either cap rejects with `EventStreamCapacityError` → HTTP 503 +
 * `Retry-After` (`src/server/errors.ts`) — a fast refusal, never a hang,
 * and never a disturbance to the streams already attached. Set a knob to
 * `0` to disable that cap.
 *
 * A per-connection max lifetime (`WARREN_EVENT_STREAM_MAX_LIFETIME`,
 * default 4h) bounds how long one stream can hold a slot, so a wedged
 * client cannot occupy a concurrency slot forever. Expiry ends the NDJSON
 * stream cleanly — indistinguishable on the wire from the broker closing
 * on run termination — and the UI's `useEventStream` tells the two apart
 * by re-reading the run state and resumes via `since` when the run is
 * still non-terminal (warren-3995), so the default-on cap is invisible
 * to live tails. Set it to `0` to disable.
 */

import { WarrenError } from "../core/errors.ts";
import { parseDurationMs } from "../preview/duration.ts";
import type { Logger, RouteContext } from "./types.ts";

export const WARREN_MAX_EVENT_STREAMS_ENV = "WARREN_MAX_EVENT_STREAMS" as const;
export const WARREN_MAX_EVENT_STREAMS_PER_CLIENT_ENV =
	"WARREN_MAX_EVENT_STREAMS_PER_CLIENT" as const;
export const WARREN_EVENT_STREAM_MAX_LIFETIME_ENV = "WARREN_EVENT_STREAM_MAX_LIFETIME" as const;
export const WARREN_EVENT_STREAM_TRUSTED_PROXY_HOPS_ENV =
	"WARREN_EVENT_STREAM_TRUSTED_PROXY_HOPS" as const;

/** Instance-wide concurrent event streams. Generous for a real audience, finite for an attacker. */
export const DEFAULT_MAX_EVENT_STREAMS = 200;
/** Per-client concurrent event streams. A tab open per run plus a couple of stale ones. */
export const DEFAULT_MAX_EVENT_STREAMS_PER_CLIENT = 5;
/**
 * Per-connection lifetime, ON by default (warren-3995): long enough that a
 * healthy tail only ever crosses it on a genuinely wedged connection, and
 * the UI resumes transparently anyway. `0` ⇒ unlimited.
 */
export const DEFAULT_EVENT_STREAM_MAX_LIFETIME_MS = 4 * 60 * 60_000;
/**
 * Right-most `X-Forwarded-For` hops to skip as trusted infrastructure when
 * deriving the per-client key (warren-46a7). `0` suits a single Caddy /
 * Ingress hop, which appends only the real client. The GKE overlay sets
 * `1`: GCLB appends `<client-ip>, <lb-ip>` after any client-supplied value,
 * so the `lb-ip` hop must be skipped to reach the client.
 */
export const DEFAULT_EVENT_STREAM_TRUSTED_PROXY_HOPS = 0;

/**
 * `Retry-After` advertised on a capacity 503. Slots free as runs finish and
 * browsers close tabs — seconds, not minutes — so a short backoff is honest.
 */
export const EVENT_STREAM_RETRY_AFTER_SECONDS = 10;

/** Prometheus gauge for currently-attached event streams (`/metrics`). */
export const METRIC_EVENT_STREAMS = "warren_event_streams";

/** Resolved caps. Any value `<= 0` means UNLIMITED — that check is skipped. */
export interface EventStreamLimits {
	/** Instance-wide concurrent streams; `<= 0` ⇒ unlimited. */
	readonly maxGlobal: number;
	/** Concurrent streams for one client key; `<= 0` ⇒ unlimited. */
	readonly maxPerClient: number;
	/** Wall-clock budget for one connection in ms; `<= 0` ⇒ unlimited. */
	readonly maxLifetimeMs: number;
	/** Right-most XFF hops skipped as trusted infrastructure when keying the per-client cap. */
	readonly trustedProxyHops: number;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the caps from env at boot. Malformed values throw here rather
 * than degrading silently at the first stream — the same fail-loud-at-boot
 * contract the preview eviction config uses.
 */
export function loadEventStreamLimitsFromEnv(env: EnvLike = process.env): EventStreamLimits {
	return {
		maxGlobal: parseEnvCount(env, WARREN_MAX_EVENT_STREAMS_ENV, DEFAULT_MAX_EVENT_STREAMS),
		maxPerClient: parseEnvCount(
			env,
			WARREN_MAX_EVENT_STREAMS_PER_CLIENT_ENV,
			DEFAULT_MAX_EVENT_STREAMS_PER_CLIENT,
		),
		maxLifetimeMs: parseEnvLifetime(
			env,
			WARREN_EVENT_STREAM_MAX_LIFETIME_ENV,
			DEFAULT_EVENT_STREAM_MAX_LIFETIME_MS,
		),
		trustedProxyHops: parseEnvCount(
			env,
			WARREN_EVENT_STREAM_TRUSTED_PROXY_HOPS_ENV,
			DEFAULT_EVENT_STREAM_TRUSTED_PROXY_HOPS,
		),
	};
}

function parseEnvCount(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
		throw new EventStreamConfigError(
			`${name} must be a non-negative integer (got ${JSON.stringify(raw)})`,
			{ recoveryHint: "set a count, or 0 to disable the cap" },
		);
	}
	return parsed;
}

function parseEnvLifetime(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	if (raw.trim() === "0") return 0;
	try {
		return parseDurationMs(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new EventStreamConfigError(`${name}: ${message}`, {
			recoveryHint: 'example: "4h", "90m"; 0 disables the lifetime cap',
		});
	}
}

/** Boot-time misconfiguration of one of the stream knobs. */
export class EventStreamConfigError extends WarrenError {
	readonly code = "event_stream_config_invalid";
}

/** Which cap tripped — surfaced as the 503's `reason` and the log's `scope`. */
export type EventStreamCapacityScope = "client" | "global";

/**
 * A stream was refused because a concurrency cap is full. Mapped to
 * `503 Service Unavailable` + `Retry-After` in `src/server/errors.ts`; the
 * `scope` tells the caller whether they are at their own cap or the whole
 * instance is saturated.
 */
export class EventStreamCapacityError extends WarrenError {
	readonly code = "event_stream_capacity";
	/** Which cap tripped. */
	readonly scope: EventStreamCapacityScope;
	/** Seconds the caller should back off before retrying (the `Retry-After`). */
	readonly retryAfterSeconds: number;

	constructor(
		message: string,
		options: { scope: EventStreamCapacityScope; retryAfterSeconds: number; recoveryHint?: string },
	) {
		super(message, {
			...(options.recoveryHint !== undefined ? { recoveryHint: options.recoveryHint } : {}),
		});
		this.scope = options.scope;
		this.retryAfterSeconds = options.retryAfterSeconds;
	}
}

/**
 * One admitted stream's reservation. `release()` is IDEMPOTENT — every
 * teardown path in `asNdjsonStream` (normal close, error, client cancel)
 * calls it, and so does lifetime expiry, so double-release must be a no-op
 * or the counters would drift negative.
 */
export interface EventStreamSlot {
	release(): void;
}

/** The reservation handed out when no limiter is wired (tests, embedders). */
const UNLIMITED_SLOT: EventStreamSlot = { release() {} };

/**
 * Counts the currently-attached NDJSON event streams and refuses new ones
 * past the configured caps. One instance per server; `ServerDeps.streamLimiter`.
 */
export class EventStreamLimiter {
	readonly limits: EventStreamLimits;
	private total = 0;
	private readonly perClient = new Map<string, number>();

	constructor(limits: EventStreamLimits) {
		this.limits = limits;
	}

	/**
	 * Reserve a slot for `clientKey`, or throw `EventStreamCapacityError`.
	 * `onExpire` (when a lifetime cap is configured) fires once the
	 * connection outlives its budget; the caller aborts the stream from it.
	 */
	acquire(clientKey: string, opts: { onExpire?: () => void } = {}): EventStreamSlot {
		const current = this.perClient.get(clientKey) ?? 0;
		if (this.limits.maxPerClient > 0 && current >= this.limits.maxPerClient) {
			throw new EventStreamCapacityError(
				`too many concurrent event streams for this client (max ${this.limits.maxPerClient})`,
				{
					scope: "client",
					retryAfterSeconds: EVENT_STREAM_RETRY_AFTER_SECONDS,
					recoveryHint: "close an open event stream before opening another",
				},
			);
		}
		if (this.limits.maxGlobal > 0 && this.total >= this.limits.maxGlobal) {
			throw new EventStreamCapacityError(
				`this warren instance is at its event-stream capacity (max ${this.limits.maxGlobal})`,
				{
					scope: "global",
					retryAfterSeconds: EVENT_STREAM_RETRY_AFTER_SECONDS,
					recoveryHint: "retry shortly, or raise WARREN_MAX_EVENT_STREAMS",
				},
			);
		}

		this.total += 1;
		this.perClient.set(clientKey, current + 1);

		// unref'd so a long lifetime budget can never keep the process alive;
		// cleared on release so a normally-closing stream leaves no timer.
		const timer =
			this.limits.maxLifetimeMs > 0 && opts.onExpire !== undefined
				? setTimeout(opts.onExpire, this.limits.maxLifetimeMs).unref()
				: undefined;

		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				if (timer !== undefined) clearTimeout(timer);
				this.total -= 1;
				const remaining = (this.perClient.get(clientKey) ?? 1) - 1;
				if (remaining <= 0) this.perClient.delete(clientKey);
				else this.perClient.set(clientKey, remaining);
			},
		};
	}

	/** Currently-attached streams across the instance — the `/metrics` gauge. */
	active(): number {
		return this.total;
	}

	/** Currently-attached streams for one client key. */
	activeFor(clientKey: string): number {
		return this.perClient.get(clientKey) ?? 0;
	}
}

/**
 * The identity the per-client cap counts against.
 *
 * The canonical deploy puts warren behind Caddy / a cluster Ingress
 * (SECURITY.md), where the socket peer is the proxy and every caller would
 * otherwise collapse into one key — so the key comes from
 * `X-Forwarded-For`, falling back to the socket peer and finally a shared
 * `"unknown"` bucket.
 *
 * Which hop is trusted matters (warren-46a7): everything LEFT of what the
 * first trusted proxy appended is client-controlled. GCLB appends to a
 * supplied header (`<supplied>, <client-ip>, <lb-ip>`), so the left-most
 * hop is attacker-set — rotating it dodged the per-client cap and let one
 * source drain the global budget. Count instead from the RIGHT: skip
 * `trustedProxyHops` infrastructure entries (`WARREN_EVENT_STREAM_TRUSTED_PROXY_HOPS`,
 * `1` on the GKE overlay for GCLB's own address, `0` for a lone Caddy /
 * Ingress hop) and take the next entry, which the trusted edge appended
 * and the client cannot influence. A chain shorter than the configured
 * trust depth falls back to the socket peer. A caller on a directly-
 * exposed instance can still forge the header to dodge its own cap; that
 * only ever costs it the per-client allowance, because the global cap
 * counts every stream regardless of key.
 */
export function eventStreamClientKey(ctx: RouteContext, trustedProxyHops = 0): string {
	const forwarded = ctx.request.headers.get("x-forwarded-for");
	if (forwarded !== null) {
		const hops = forwarded
			.split(",")
			.map((hop) => hop.trim())
			.filter((hop) => hop !== "");
		const clientIndex = hops.length - 1 - trustedProxyHops;
		const client = clientIndex >= 0 ? hops[clientIndex] : undefined;
		if (client !== undefined) return client;
	}
	const peer = ctx.clientIp?.trim();
	return peer !== undefined && peer !== "" ? peer : "unknown";
}

export interface ReserveEventStreamSlotInput {
	/** Absent (tests, embedders wiring `ServerDeps` by hand) ⇒ uncapped. */
	readonly limiter: EventStreamLimiter | undefined;
	readonly ctx: RouteContext;
	/** Aborted on lifetime expiry — the handler's stream controller. */
	readonly ctrl: AbortController;
	/** Route label for the rejection log, e.g. `GET /runs/:id/events`. */
	readonly route: string;
}

/**
 * Admission wrapper both event-stream handlers call: derive the client key,
 * reserve a slot, and log the refusal at the level its scope deserves —
 * `warn` for instance saturation (an operator signal), `info` for one
 * client hitting its own allowance (routine under load). Rethrows so the
 * server's error pipeline renders the 503 + `Retry-After`.
 */
export function reserveEventStreamSlot(input: ReserveEventStreamSlotInput): EventStreamSlot {
	const { limiter, ctx, ctrl, route } = input;
	if (limiter === undefined) return UNLIMITED_SLOT;
	const clientKey = eventStreamClientKey(ctx, limiter.limits.trustedProxyHops);
	try {
		return limiter.acquire(clientKey, { onExpire: () => ctrl.abort() });
	} catch (err) {
		if (err instanceof EventStreamCapacityError) {
			logCapacityRejection(ctx.logger, err, { route, clientKey, limiter });
		}
		throw err;
	}
}

function logCapacityRejection(
	logger: Logger,
	err: EventStreamCapacityError,
	ctx: { route: string; clientKey: string; limiter: EventStreamLimiter },
): void {
	const fields = {
		route: ctx.route,
		scope: err.scope,
		client: ctx.clientKey,
		client_streams: ctx.limiter.activeFor(ctx.clientKey),
		active_streams: ctx.limiter.active(),
	};
	if (err.scope === "global") {
		logger.warn(fields, "event stream refused: instance at capacity");
		return;
	}
	logger.info(fields, "event stream refused: client at capacity");
}

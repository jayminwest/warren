/**
 * Sentry error tracking sink (warren observability Phase 1).
 *
 * Opt-in and gated on `SENTRY_DSN` — unset is a no-op tracker, so the
 * standalone fresh-install path carries zero Sentry overhead (matches
 * warren's bundled-feature philosophy). When a DSN is present, the heavy
 * `@sentry/bun` tree is loaded via dynamic import so an unconfigured
 * deployment never pays for it at boot.
 *
 * Defense-in-depth: `scrubSentryEvent` runs as Sentry's `beforeSend` and
 * censors any secret-shaped field (reusing the central `SECRET_FIELDS`
 * policy) in the event's `extra` / `request.headers`, so a token can't leave
 * the box even if a caller attaches a whole config/headers object as context.
 *
 * The pino → Sentry forwarding lives in `./log-sink.ts`; this module owns the
 * tracker lifecycle (init / capture / flush) and the scrubber.
 */

import { SECRET_FIELDS } from "../server/main/redact.ts";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface ErrorTracker {
	readonly enabled: boolean;
	captureException(err: unknown, context?: Record<string, unknown>): void;
	captureMessage(message: string, context?: Record<string, unknown>): void;
	flush(timeoutMs?: number): Promise<void>;
}

export interface InitErrorTrackingResult {
	readonly tracker: ErrorTracker;
	readonly environment: string;
}

export const NOOP_ERROR_TRACKER: ErrorTracker = {
	enabled: false,
	captureException: () => {},
	captureMessage: () => {},
	flush: async () => {},
};

const REDACTED = "[Redacted]";
const SECRET_FIELD_SET = new Set<string>(SECRET_FIELDS.map((f) => f.toLowerCase()));

/**
 * Resolve the Sentry tracker from env. Returns the no-op tracker when
 * `SENTRY_DSN` is unset/blank. Otherwise dynamically imports `@sentry/bun`,
 * initializes it with the secret scrubber, and returns a thin wrapper.
 */
export async function initErrorTracking(env: EnvLike): Promise<InitErrorTrackingResult> {
	const dsn = env.SENTRY_DSN?.trim();
	const environment = env.SENTRY_ENVIRONMENT?.trim() || "production";
	if (dsn === undefined || dsn === "") {
		return { tracker: NOOP_ERROR_TRACKER, environment };
	}

	const Sentry = await import("@sentry/bun");
	const release = env.SENTRY_RELEASE?.trim();
	Sentry.init({
		dsn,
		environment,
		// Errors-only in V1; tracing/profiling deferred to a later phase.
		tracesSampleRate: 0,
		...(release !== undefined && release !== "" ? { release } : {}),
		beforeSend: (event) => {
			scrubSentryEvent(event as unknown as Record<string, unknown>);
			return event;
		},
	});

	const tracker: ErrorTracker = {
		enabled: true,
		captureException: (err, context) => {
			Sentry.captureException(err, context !== undefined ? { extra: context } : undefined);
		},
		captureMessage: (message, context) => {
			Sentry.captureMessage(message, {
				level: "error",
				...(context !== undefined ? { extra: context } : {}),
			});
		},
		flush: async (timeoutMs) => {
			await Sentry.flush(timeoutMs);
		},
	};
	return { tracker, environment };
}

/**
 * Censor secret-shaped fields from a Sentry event before it leaves the
 * process. Walks `event.extra` and `event.request.headers` (the two places
 * warren attaches caller-supplied context) and redacts any key whose
 * lowercased name matches the central secret-field policy. Pure + exported so
 * it is unit-tested without a live DSN.
 */
export function scrubSentryEvent(event: Record<string, unknown>): Record<string, unknown> {
	const extra = event.extra;
	if (isRecord(extra)) event.extra = scrubRecord(extra);
	const request = event.request;
	if (isRecord(request) && isRecord(request.headers)) {
		request.headers = scrubRecord(request.headers);
	}
	return event;
}

/**
 * Redact secret-shaped keys from a record. Recurses exactly one level into
 * nested record values so that `{ config: { token } }` is censored, matching
 * the central pino policy (top-level fields plus the `*.<field>` wildcard in
 * `LOG_REDACT_PATHS`). pino redact is not deep-recursive, so neither is this.
 */
function scrubRecord(record: Record<string, unknown>, depth = 0): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (SECRET_FIELD_SET.has(key.toLowerCase())) {
			out[key] = REDACTED;
		} else if (depth === 0 && isRecord(value)) {
			out[key] = scrubRecord(value, depth + 1);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

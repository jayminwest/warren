/**
 * pino → observability sink bridge (warren observability Phase 1).
 *
 * Wired into the root logger's `hooks.logMethod` (see `createWarrenLogger`),
 * this fans every log call out to two sinks before the line is actually
 * written:
 *
 *   - **Metrics**: increments `warren_log_messages_total{level}` for every
 *     warn/error/fatal line, so Grafana can `rate()` the warn/error stream
 *     (this is what caught the cron spam from an unregistered scheduled
 *     agent retrying every tick — a `warn`, level 40).
 *   - **Sentry**: forwards error/fatal lines (level >= 50) as exceptions (when
 *     the log object carries an `Error` under `err`/`error`) or messages. The
 *     structured log object becomes Sentry `extra`; the redaction scrubber on
 *     the tracker side strips any secret-shaped field.
 *
 * Pure-ish: `forwardLogToSinks` takes the numeric pino level + the original
 * log args and the two (optional) sinks, so it is unit-tested with stub sinks
 * and no real pino/Sentry.
 */

import type { MetricsRegistry } from "./metrics-registry.ts";

export interface LogForwardTracker {
	captureException(err: unknown, context?: Record<string, unknown>): void;
	captureMessage(message: string, context?: Record<string, unknown>): void;
}

export interface LogSinks {
	readonly metrics?: MetricsRegistry;
	readonly tracker?: LogForwardTracker;
}

const WARN_LEVEL = 40;
const ERROR_LEVEL = 50;

/** Map a pino numeric level to its canonical name (for the metric label). */
export function pinoLevelName(level: number): string {
	if (level >= 60) return "fatal";
	if (level >= 50) return "error";
	if (level >= 40) return "warn";
	if (level >= 30) return "info";
	if (level >= 20) return "debug";
	return "trace";
}

/**
 * Fan one pino log call out to the metrics + Sentry sinks. `args` is pino's
 * raw `logMethod` argument array — either `(obj, msg)`, `(obj)`, or `(msg)`.
 */
export function forwardLogToSinks(level: number, args: unknown[], sinks: LogSinks): void {
	if (level < WARN_LEVEL) return;
	const { obj, msg } = parseLogArgs(args);

	if (sinks.metrics !== undefined) {
		sinks.metrics.increment("warren_log_messages_total", { level: pinoLevelName(level) });
	}

	if (sinks.tracker !== undefined && level >= ERROR_LEVEL) {
		const message = msg ?? "warren.error";
		const error = extractError(obj);
		if (error !== undefined) {
			sinks.tracker.captureException(error, { ...obj, msg: message });
		} else {
			sinks.tracker.captureMessage(message, obj);
		}
	}
}

function parseLogArgs(args: unknown[]): { obj: Record<string, unknown>; msg: string | undefined } {
	const first = args[0];
	if (typeof first === "string") return { obj: {}, msg: first };
	if (isRecord(first)) {
		const second = args[1];
		return { obj: first, msg: typeof second === "string" ? second : undefined };
	}
	return { obj: {}, msg: undefined };
}

function extractError(obj: Record<string, unknown>): Error | undefined {
	if (obj.err instanceof Error) return obj.err;
	if (obj.error instanceof Error) return obj.error;
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

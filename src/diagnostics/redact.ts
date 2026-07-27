/**
 * Disclosure guards for the diagnostics surface (warren-51de / pl-b82d
 * step 2).
 *
 * `GET /readyz` renders every `DiagnosticCheck.message` verbatim, so
 * anything a check interpolates is on the wire. Raw driver text names the
 * database host, port, and role; raw filesystem errors name the server's
 * absolute paths. Neither is worth more to an operator than a stable
 * reason code, and both narrow the search space for anyone probing the
 * deploy.
 *
 * This module is the one place that turns an unvetted failure into a
 * wire-safe reason: {@link classifyDbFailure} maps a driver error onto a
 * FIXED code set, and {@link dbFailureMessage} logs the raw text under the
 * failing check's name before returning only the code. Same body/log split
 * the HTTP layer uses for unhandled 500s (`renderError` + `errorLogFields`,
 * warren-4385).
 *
 * Not to be confused with `src/server/main/redact.ts`, which is pino's
 * secret-field censoring policy for structured log objects.
 */

import type { DiagnosticLogger } from "./checks.ts";

/**
 * Stable, wire-safe reason codes for a failed database probe. Treat as a
 * public contract — operators and the acceptance harness match on these.
 */
export type DbFailureReason = "unreachable" | "auth_failed" | "migration_pending" | "unknown";

/** Postgres role/credential rejections. Deliberately excludes filesystem
 * `EACCES` (a sqlite file the process cannot open is "unreachable", not an
 * auth failure). */
const AUTH_FAILED =
	/password authentication failed|authentication failed|no pg_hba\.conf entry|sasl|role .* does not exist/i;

/** The connection works but the schema does not — a missing migration. */
const MIGRATION_PENDING =
	/no such table|relation .* does not exist|undefined_?table|no such column|column .* does not exist/i;

/** Nothing answered: socket, DNS, timeout, or a handle already torn down. */
const UNREACHABLE =
	/econnrefused|enotfound|ehostunreach|etimedout|econnreset|epipe|eacces|connection terminated|connection (is )?closed|closed database|server closed the connection|timeout expired|unable to open database|sqlite_cantopen|database is locked/i;

/**
 * Map a driver error onto the fixed reason set. Matches on the error's
 * `name: message` text because the drivers warren speaks to (`pg`,
 * `bun:sqlite`) carry no common structured code. Anything unrecognized is
 * `unknown` rather than a guess — the raw text is in the logs.
 */
export function classifyDbFailure(err: unknown): DbFailureReason {
	const text = rawFailureText(err);
	if (AUTH_FAILED.test(text)) return "auth_failed";
	if (MIGRATION_PENDING.test(text)) return "migration_pending";
	if (UNREACHABLE.test(text)) return "unreachable";
	return "unknown";
}

/**
 * The wire-safe message for a failed database probe: a stable reason code
 * and nothing else. The raw driver text goes to `log` (when the caller
 * wired one) under the failing check's name, so an operator loses no
 * detail — it just moves from the response body to the server log.
 */
export function dbFailureMessage(check: string, err: unknown, log?: DiagnosticLogger): string {
	const reason = classifyDbFailure(err);
	log?.warn(
		{ event: "diagnostics.probe_failed", check, reason, err_message: rawFailureText(err) },
		"diagnostics database probe failed",
	);
	return `probe failed (reason=${reason})`;
}

function rawFailureText(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

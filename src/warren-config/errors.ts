/**
 * Errors specific to the per-project `.warren/` config module (R-02).
 *
 * `WarrenConfigUnavailableError` covers filesystem failures: project clone
 * vanished, `.warren/` unreadable due to permissions, etc. Maps to a 503 at
 * the warren HTTP boundary — the right operator action is "fix the host"
 * rather than "retry the request".
 *
 * Per-file parse and schema failures are NOT thrown — the loader collects
 * them as structured `WarrenConfigFileError` entries so a single malformed
 * file (triggers.yaml) doesn't hide a healthy sibling (defaults.json) from
 * the operator. Callers (HTTP, doctor, UI) render the errors envelope
 * verbatim.
 *
 * Non-fatal advisories (e.g. defaults.json deprecation, warren-5840) share
 * the same shape and live alongside `errors` in a separate `warnings`
 * array — the loader, doctor, and UI all treat them as informational.
 */

import { WarrenError } from "../core/errors.ts";

export class WarrenConfigUnavailableError extends WarrenError {
	readonly code = "warren_config_unavailable";
}

/**
 * A guardrail-bearing `.warren/` file EXISTS on disk but failed to parse or
 * validate (warren-02aa). The loader still reports such failures as
 * `errors[]` entries for the read-only surfaces (doctor, readyz, UI); this
 * error is what the DISPATCH path raises so a project whose policy file is
 * broken refuses to run rather than running with its admission cap, quality
 * gate, resource limits, and cost caps silently dropped. Maps to 422 at the
 * warren HTTP boundary — the fix is to correct the file and re-dispatch.
 */
export class WarrenConfigInvalidError extends WarrenError {
	readonly code = "warren_config_invalid";
}

/**
 * Stable codes for per-file failures and advisories collected by the
 * loader. Surfaced to the HTTP/UI/doctor layers; treat as a public
 * contract.
 */
export const WARREN_CONFIG_FILE_ERROR_CODES = {
	parseError: "warren_config_parse_error",
	schemaError: "warren_config_schema_error",
	/** Non-fatal: surfaced via `warnings`, not `errors`. */
	deprecated: "warren_config_deprecated",
} as const;

export type WarrenConfigFileErrorCode =
	(typeof WARREN_CONFIG_FILE_ERROR_CODES)[keyof typeof WARREN_CONFIG_FILE_ERROR_CODES];

export interface WarrenConfigFileError {
	/** Project-relative path, e.g. `.warren/triggers.yaml`. */
	readonly file: string;
	readonly code: WarrenConfigFileErrorCode;
	readonly message: string;
}

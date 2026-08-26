/**
 * CLI error and exit-code contract (plan pl-91b6 step 10, warren-d050).
 *
 * Exit codes are the stable operator surface — scripts and tests pin them:
 *
 * - 0 — ok
 * - 1 — usage error (unknown command/flag, malformed argv)
 * - 2 — invalid input (manifest/policy validation failure)
 * - 3 — invalid config (missing file path, missing named secret env var)
 * - 4 — refused (admission refusal, state error, boundary violation,
 *       concurrent tick)
 * - 5 — upstream failure (warren/github transport errors)
 */
import { AdmissionRefusal } from "../admission-errors.ts";
import {
	BoundaryError,
	CampaignControllerError,
	ConfigError,
	StateError,
	ValidationError,
} from "../errors.ts";
import { PrIntentRefusal } from "../pr-intent/intender.ts";
import { TickConcurrentError } from "../tick/tick.ts";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_INPUT_INVALID = 2;
export const EXIT_CONFIG_INVALID = 3;
export const EXIT_REFUSED = 4;
export const EXIT_UPSTREAM = 5;

/** An argv-level failure: unknown command, unknown flag, missing value. */
export class CliError extends CampaignControllerError {
	constructor(message: string) {
		super("usage_invalid", message);
		this.name = "CliError";
	}
}

/** Map a thrown error onto the exit-code table. */
export function exitCodeFor(error: unknown): number {
	if (error instanceof CliError) {
		return EXIT_USAGE;
	}
	if (error instanceof ValidationError) {
		return EXIT_INPUT_INVALID;
	}
	if (error instanceof ConfigError) {
		return EXIT_CONFIG_INVALID;
	}
	if (
		error instanceof AdmissionRefusal ||
		error instanceof PrIntentRefusal ||
		error instanceof StateError ||
		error instanceof BoundaryError ||
		error instanceof TickConcurrentError
	) {
		return EXIT_REFUSED;
	}
	return EXIT_UPSTREAM;
}

/**
 * The JSON error payload of one CLI failure: a stable `code`, a secret-free
 * `message`, and the refusal `invariant` when the error carries one.
 */
export function errorPayload(error: unknown): {
	code: string;
	message: string;
	invariant?: string;
} {
	if (error instanceof AdmissionRefusal || error instanceof PrIntentRefusal) {
		return { code: error.code, message: error.message, invariant: error.invariant };
	}
	if (error instanceof CampaignControllerError) {
		return { code: error.code, message: error.message };
	}
	return { code: "unknown", message: String(error) };
}

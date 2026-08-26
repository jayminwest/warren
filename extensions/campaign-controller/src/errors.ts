/**
 * Base error types for the campaign controller.
 *
 * V0 establishes only the hierarchy every later step throws through; each
 * subclass gains fields (issue refs, journal ids, upstream coordinates) when
 * its owning step lands. Every controller error carries a stable `code` so
 * the CLI can emit machine-readable failures without string-matching
 * messages, and every `message` stays free of secrets by construction —
 * credentials never enter error text (plan pl-91b6 risk 5).
 */

/** Stable machine-readable failure codes every controller error can carry. */
export type CampaignControllerErrorCode =
	| "input_invalid"
	| "config_invalid"
	| "state_invalid"
	| "boundary_violated"
	| "not_implemented"
	/* Warren transport failures (warren-a732). Additive codes for the V0
	 * Warren HTTP client; every message stays secret-free by construction. */
	| "warren_auth_rejected"
	| "warren_rejected"
	| "warren_rate_limited"
	| "warren_unreachable"
	| "warren_envelope_invalid"
	| "dispatch_uncertain"
	| "admission_refused"
	| "upstream_error"
	| "rate_limited"
	/* CLI surface codes (warren-d050): argv/refusal failures surfaced by the
	 * operator CLI. Additive; every message stays secret-free. */
	| "usage_invalid"
	| "tick_concurrent";

/** Root of every error the campaign controller raises. */
export class CampaignControllerError extends Error {
	/** Stable machine-readable discriminator, e.g. `manifest_invalid`. */
	readonly code: CampaignControllerErrorCode;

	constructor(code: CampaignControllerErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CampaignControllerError";
		this.code = code;
	}

	/** JSON shape for machine-readable CLI output. */
	toJson(): { error: string; code: CampaignControllerErrorCode; message: string } {
		return { error: this.name, code: this.code, message: this.message };
	}
}

/** An immutable input (manifest, repository policy, approval) is malformed. */
export class ValidationError extends CampaignControllerError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("input_invalid", message, options);
		this.name = "ValidationError";
	}
}

/** Environment or configuration is missing or unusable. */
export class ConfigError extends CampaignControllerError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("config_invalid", message, options);
		this.name = "ConfigError";
	}
}

/** Durable state contradicts itself or the campaign invariants. */
export class StateError extends CampaignControllerError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("state_invalid", message, options);
		this.name = "StateError";
	}
}

/** An operation would cross the V0 dry-run / no-mutation boundary. */
export class BoundaryError extends CampaignControllerError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("boundary_violated", message, options);
		this.name = "BoundaryError";
	}
}

/** Is this thrown object one of ours? Narrows `unknown` at catch sites. */
export function isCampaignControllerError(value: unknown): value is CampaignControllerError {
	return value instanceof CampaignControllerError;
}

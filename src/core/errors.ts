/**
 * Error hierarchy with stable codes and recovery hints (SPEC §7).
 *
 * Higher layers (HTTP server, CLI) format errors as `[<code>] <message>` plus
 * an optional recovery hint. Library callers can catch by class or switch on
 * `code`. Modeled after burrow's BurrowError so the two stay legible together.
 */

export abstract class WarrenError extends Error {
	abstract readonly code: string;
	readonly recoveryHint?: string;

	constructor(message: string, options?: { cause?: unknown; recoveryHint?: string }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = this.constructor.name;
		if (options?.recoveryHint !== undefined) {
			this.recoveryHint = options.recoveryHint;
		}
	}
}

export class NotFoundError extends WarrenError {
	readonly code = "not_found";
}

export class ValidationError extends WarrenError {
	readonly code = "validation_error";
}

export class StateTransitionError extends WarrenError {
	readonly code = "state_transition_error";
}

/**
 * Canonical minimal error formatter: the `.message` for `Error` instances,
 * otherwise `String(err)`. Used everywhere a reason string is slotted into a
 * log field, a failure-envelope `reason`, or a wrapped error message.
 *
 * Deliberately code/hint-free — the richer `[<code>] <message>\n  hint: ...`
 * rendering lives in `src/cli/output.ts` (terminal-facing) and the
 * null/object-aware variant lives in `src/ui/src/lib/format-error.ts`
 * (browser-facing); both are kept separate so their output stays stable.
 */
export function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

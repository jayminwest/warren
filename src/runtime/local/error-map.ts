/**
 * The LocalProvider's burrow → provider-neutral error seam (warren-36cb).
 *
 * This is the ONE place the LocalProvider translates a `@os-eco/burrow-cli`
 * error class into the runtime taxonomy (`../errors.ts`) so the domain and the
 * HTTP layer never catch a burrow class. Transport failures already arrive
 * neutral — `withTransportMapping` throws `BurrowUnreachableError`, which
 * extends `RuntimeUnreachableError`, so they need no mapping here.
 *
 * `mapBurrowError` returns the NEUTRAL error for the burrow classes with a
 * neutral analogue, and returns the original value unchanged for everything
 * else. A seam method calls it in a `catch` and rethrows the result, so a
 * mapped class becomes neutral while an unmapped one propagates verbatim (the
 * HTTP layer then maps it by `code` via `runtimeBackendStatusFor`, keeping the
 * envelope byte-identical). Kept a pure `unknown → unknown` function so callers
 * stay a one-line `throw mapBurrowError(err, ...)`.
 */

import { NotFoundError as BurrowNotFoundError, ToolchainMismatch } from "@os-eco/burrow-cli";
import { RuntimeConflictError, RuntimeRunNotFoundError } from "../errors.ts";

export interface MapBurrowErrorOptions {
	/**
	 * Recovery hint stamped onto the neutralized `RuntimeRunNotFoundError` — the
	 * seam sites word it differently (cancel: terminalize the row; sendMessage:
	 * the bridge reconciles the run to failed), so each passes its own.
	 */
	readonly runNotFoundHint?: string;
}

/**
 * Translate a burrow-side error into the provider-neutral runtime taxonomy.
 * Returns the original value unchanged when there is no neutral analogue.
 */
export function mapBurrowError(err: unknown, options?: MapBurrowErrorOptions): unknown {
	if (err instanceof BurrowNotFoundError) {
		// A ghost run/burrow: the backend has no record of the handle.
		return new RuntimeRunNotFoundError(err.message, {
			cause: err,
			...(options?.runNotFoundHint !== undefined ? { recoveryHint: options.runNotFoundHint } : {}),
		});
	}
	if (err instanceof ToolchainMismatch) {
		// A backend state clash → the neutral 409 conflict.
		return new RuntimeConflictError(err.message, {
			cause: err,
			...(err.recoveryHint !== undefined ? { recoveryHint: err.recoveryHint } : {}),
		});
	}
	return err;
}

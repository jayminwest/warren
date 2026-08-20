/**
 * Shared SIGINT-detach tail for the remote streaming commands
 * (`warren run`, `warren plan run`) — warren-97a2.
 *
 * Both commands tail a server's NDJSON event stream until it closes at the
 * terminal state, and both implement the same detach contract: the first
 * SIGINT prints a hint and aborts the LOCAL stream only (the remote run
 * keeps going), the second SIGINT force-exits with {@link SIGINT_EXIT_CODE}.
 * The wiring lived in two byte-near copies (plan-run.ts and run.ts); this
 * module owns it once.
 */

import type { WarrenClient } from "../../client/index.ts";
import { type CliContext, EXIT_SIGINT_DETACH, formatError } from "../output.ts";

/** Exit code emitted when the operator detaches a live tail with SIGINT. */
export const SIGINT_EXIT_CODE = EXIT_SIGINT_DETACH;

/** Disposer returned by the `onSigint` seam: unregisters the handler. */
export type SigintDisposer = () => void;

/** Default SIGINT registration against the live process (production). */
export function defaultOnSigint(handler: () => void): SigintDisposer {
	process.on("SIGINT", handler);
	return () => {
		process.off("SIGINT", handler);
	};
}

export interface TailWithDetachInput<T> {
	readonly context: CliContext;
	/** stderr line printed on the first SIGINT (names the id + how to cancel). */
	readonly detachHint: string;
	/** Open the event stream; the signal aborts the underlying fetch. */
	readonly stream: (signal: AbortSignal) => AsyncIterable<T>;
	/** Consume one streamed event (render, write NDJSON, …). */
	readonly onEvent: (event: T) => void;
	/** SIGINT seam (tests). Defaults to the live `process` registration. */
	readonly onSigint?: (handler: () => void) => SigintDisposer;
	/** Hard-exit seam (tests). Defaults to `process.exit`. */
	readonly exit?: (code: number) => never;
}

export type TailOutcome =
	| { readonly kind: "completed" }
	| { readonly kind: "detached" }
	| { readonly kind: "error"; readonly err: unknown };

/**
 * The dep fields every remote streaming command shares. Command-specific
 * deps interfaces extend this rather than re-declaring (and re-documenting)
 * the same four fields.
 */
export interface RemoteTailDeps {
	/** Remote warren client. Production wires `resolveCommandClient(context, opts)`. */
	readonly client: WarrenClient;
	/**
	 * SIGINT seam (tests). Registers `handler` and returns a disposer that
	 * unregisters it. When omitted the command falls back to the live
	 * `process` registration.
	 */
	readonly onSigint?: (handler: () => void) => SigintDisposer;
	/** Hard-exit seam (tests). Defaults to `process.exit`. */
	readonly exit?: (code: number) => never;
	/** Override the probe timeout (tests). */
	readonly probeTimeoutMs?: number;
}

/** Map a non-completed {@link TailOutcome} to an exit code, reporting errors to stderr. */
export function tailOutcomeExit(
	context: CliContext,
	outcome: Exclude<TailOutcome, { readonly kind: "completed" }>,
): number {
	if (outcome.kind === "detached") {
		return SIGINT_EXIT_CODE;
	}
	context.stdio.stderr.write(`warren: ${formatError(outcome.err)}\n`);
	return 1;
}

/**
 * Consume `stream` until it closes, a non-abort error throws, or the
 * operator detaches with SIGINT. Abort errors raised BY the detach are
 * swallowed; any other error surfaces as `{kind: "error"}`.
 */
export async function tailWithDetach<T>(input: TailWithDetachInput<T>): Promise<TailOutcome> {
	const onSigint = input.onSigint ?? defaultOnSigint;
	const exit = input.exit ?? (process.exit as (code: number) => never);
	const tailAbort = new AbortController();
	let interrupted = false;

	const dispose = onSigint(() => {
		if (interrupted) {
			// Second SIGINT: stop waiting and hand control back to the shell.
			exit(SIGINT_EXIT_CODE);
			return;
		}
		interrupted = true;
		input.context.stdio.stderr.write(input.detachHint);
		tailAbort.abort();
	});

	try {
		for await (const event of input.stream(tailAbort.signal)) {
			input.onEvent(event);
		}
	} catch (err) {
		if (!interrupted) {
			return { kind: "error", err };
		}
		// Interrupted tails surface an AbortError — swallow it.
	} finally {
		dispose();
	}

	return interrupted ? { kind: "detached" } : { kind: "completed" };
}

/**
 * Best-effort run-event stamp shared by handlers that record a system event
 * outside reap (warren-cd3b: extracted so the heal-dispatch stamp and the
 * salvage stamp stop being two drifting copies — jscpd flagged the pair).
 *
 * Fire-and-log: a failed event write must not turn the request that triggered
 * it into a 500, so the error is logged (at `level`) and swallowed. The seq
 * is `maxSeqForRun + 1` read at write time; a collision with a concurrent
 * writer lands in the log, not the response.
 */

import type { ServerDeps } from "../types.ts";

/** The narrow logger surface the stamp needs (deps.logger or a request-bound child). */
export interface StampLogger {
	readonly error: (obj: Record<string, unknown>, msg: string) => void;
	readonly warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface StampRunEventInput {
	readonly runId: string;
	readonly kind: string;
	readonly payload: unknown;
	/** Log level for a failed write — `error` when the stamp guards idempotency. */
	readonly level: "error" | "warn";
	/** Log message for the failure path. */
	readonly message: string;
}

export async function stampRunSystemEvent(
	deps: ServerDeps,
	logger: StampLogger,
	input: StampRunEventInput,
): Promise<void> {
	try {
		const seq = ((await deps.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const now = (deps.now ?? (() => new Date()))();
		await deps.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: seq,
			ts: now.toISOString(),
			kind: input.kind,
			stream: "system",
			payload: input.payload,
		});
	} catch (err) {
		logger[input.level](
			{ runId: input.runId, reason: err instanceof Error ? err.message : String(err) },
			input.message,
		);
	}
}

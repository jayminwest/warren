/**
 * Bounded drop policy for a failed `events.append` (warren-fb5e).
 *
 * A poison event (Postgres jsonb rejecting U+0000) used to throw out of the
 * bridge loop, flip `errored`, and make the reconnect loop replay the same
 * event until `bridge_lost` killed a healthy run. Swallowing every failure
 * is the opposite hazard: a DB outage would silently drop the whole stream
 * and report success. This guard drops a failure and returns `null`, but
 * rethrows once `MAX_CONSECUTIVE_APPEND_FAILURES` failures land in a row so
 * a persistent store fault still reaches the reconnect path. Any success
 * resets the streak.
 */

import type { AppendEventInput, EventsRepo } from "../../db/repos/events.ts";
import type { EventRow } from "../../db/schema.ts";
import type { BridgeLogger } from "./types.ts";

export const MAX_CONSECUTIVE_APPEND_FAILURES = 3;

export interface AppendGuard {
	consecutiveFailures: number;
}

export function newAppendGuard(): AppendGuard {
	return { consecutiveFailures: 0 };
}

/**
 * Append `input`, returning the row on success or `null` when the failure
 * was dropped. Throws the append error itself once the streak reaches
 * `MAX_CONSECUTIVE_APPEND_FAILURES`.
 */
export async function appendOrDrop(
	guard: AppendGuard,
	events: Pick<EventsRepo, "append">,
	input: AppendEventInput,
	logger?: BridgeLogger,
): Promise<EventRow | null> {
	try {
		const row = await events.append(input);
		guard.consecutiveFailures = 0;
		return row;
	} catch (err) {
		guard.consecutiveFailures += 1;
		const persistent = guard.consecutiveFailures >= MAX_CONSECUTIVE_APPEND_FAILURES;
		logger?.error?.(
			{
				runId: input.runId,
				kind: input.kind,
				sandboxEventSeq: input.sandboxEventSeq,
				consecutiveFailures: guard.consecutiveFailures,
				err,
			},
			persistent
				? "bridge append failed repeatedly; surfacing as stream error"
				: "bridge dropped event after append failure",
		);
		if (persistent) throw err;
		return null;
	}
}

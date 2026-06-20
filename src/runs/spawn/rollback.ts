/**
 * Spawn-flow logging + rollback helpers (warren-c686 / pl-f700 step 1).
 *
 * Split out of `dispatch.ts` to keep that file under the 500-line size
 * ratchet while still instrumenting every failure branch. Holds:
 *
 *   - the no-op `SpawnLogger` fallback so the dispatch flow can log
 *     unconditionally,
 *   - `bindRunLogger` which re-binds `run_id` onto the caller's
 *     request-scoped logger once per spawn, and
 *   - `rollback`, the queued→cancelled + best-effort burrow-destroy
 *     unwind, now logging both previously-swallowed failure branches.
 */

import type { Burrow } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { SpawnLogger, SpawnRunInput } from "./types.ts";

/**
 * No-op `SpawnLogger` (warren-c686). Lets the instrumentation call
 * `log.info(...)` unconditionally without every call site re-checking
 * `input.logger !== undefined`. Returns itself from `child` so a bound
 * child is always a real logger too.
 */
const NOOP_SPAWN_LOGGER: Required<Pick<SpawnLogger, "info" | "warn" | "error">> &
	Pick<SpawnLogger, "child"> = {
	info: () => {},
	warn: () => {},
	error: () => {},
	child() {
		return NOOP_SPAWN_LOGGER;
	},
};

/** Bind `run_id` onto the caller's logger (or the no-op) once per spawn. */
export function bindRunLogger(logger: SpawnLogger | undefined, runId: string): SpawnLogger {
	const base = logger ?? NOOP_SPAWN_LOGGER;
	return base.child?.({ run_id: runId }) ?? base;
}

/** warren-c686: worker placement resolved (logged before the run row exists). */
export function logPlacement(
	logger: SpawnLogger | undefined,
	workerId: string,
	projectId: string,
): void {
	logger?.info(
		{ event: "spawn.placement", worker_id: workerId, project_id: projectId },
		"spawn: worker placement resolved",
	);
}

/** warren-c686: burrow provisioned, with provision latency. */
export function logProvisioned(
	log: SpawnLogger,
	burrowId: string,
	workerId: string,
	startedAt: number,
): void {
	log.info(
		{
			event: "spawn.provisioned",
			burrow_id: burrowId,
			worker_id: workerId,
			duration_ms: Date.now() - startedAt,
		},
		"spawn: burrow provisioned",
	);
}

/** warren-c686: run dispatched onto the burrow, with dispatch latency. */
export function logDispatched(
	log: SpawnLogger,
	burrowId: string,
	burrowRunId: string,
	startedAt: number,
): void {
	log.info(
		{
			event: "spawn.dispatched",
			burrow_id: burrowId,
			burrow_run_id: burrowRunId,
			duration_ms: Date.now() - startedAt,
		},
		"spawn: run dispatched onto burrow",
	);
}

/** warren-c686: spawn failed past the warren-row point; about to roll back. */
export function logSpawnFailed(log: SpawnLogger, burrowId: string | null, err: unknown): void {
	log.warn(
		{ event: "spawn.failed", burrow_id: burrowId, error: errorMessage(err) },
		"spawn: failed, rolling back",
	);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function rollback(
	input: SpawnRunInput,
	runId: string,
	burrow: Burrow | null,
	client: BurrowClient,
	log: SpawnLogger,
): Promise<void> {
	try {
		await input.repos.runs.finalize(runId, "cancelled", input.now?.());
	} catch (err) {
		// Either the row was already terminal (shouldn't happen on this path)
		// or the db handle is gone — either way, nothing to recover here.
		// warren-c686: previously swallowed silently; surface it so a stuck
		// `queued` row left behind by a failed finalize is debuggable.
		log.error(
			{ event: "spawn.rollback.finalize_failed", error: errorMessage(err) },
			"spawn rollback: runs.finalize failed",
		);
	}
	if (burrow !== null) {
		try {
			await withTransportMapping(client.config, () =>
				client.http.burrows.destroy(burrow.id, { archive: false }),
			);
		} catch (err) {
			// Best-effort cleanup. The operator can list stranded burrows via
			// burrow's own UI / CLI; we don't want a cleanup failure to mask
			// the original error the caller is about to see rethrown.
			// warren-c686: log the swallowed failure so stranded burrows are
			// traceable to the run that leaked them.
			log.error(
				{
					event: "spawn.rollback.burrow_destroy_failed",
					burrow_id: burrow.id,
					error: errorMessage(err),
				},
				"spawn rollback: burrow destroy failed; burrow may be stranded",
			);
		}
	}
}

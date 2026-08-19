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
 *   - `rollback`, the queued→failed(never_started) warren-row unwind
 *     (warren-c42c: the burrow-half teardown moved behind the runtime
 *     seam — `RuntimeProvider.create()` owns destroying a partially
 *     provisioned sandbox — so this is purely the domain-row unwind).
 */

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

/**
 * Bind `run_id` (and, when present, dispatch provenance) onto the caller's
 * logger once per spawn (warren-c686 / warren-9ce3). Reading
 * `dispatcherHandle` + `dispatchOrigin` here is what keeps them from being
 * dropped silently — the dispatch-context writer (warren-d6ca) will also
 * consume them off the input bag, but the logger binding is the live carry
 * until that lands.
 */
export function bindRunLogger(
	logger: SpawnLogger | undefined,
	runId: string,
	provenance?: {
		readonly dispatcherHandle?: string;
		readonly dispatchOrigin?: string;
	},
): SpawnLogger {
	const base = logger ?? NOOP_SPAWN_LOGGER;
	const bindings: Record<string, string> = { run_id: runId };
	if (provenance?.dispatcherHandle !== undefined && provenance.dispatcherHandle !== "") {
		bindings.dispatcher_handle = provenance.dispatcherHandle;
	}
	if (provenance?.dispatchOrigin !== undefined) {
		bindings.dispatch_origin = provenance.dispatchOrigin;
	}
	return base.child?.(bindings) ?? base;
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
	sandboxId: string,
	workerId: string,
	startedAt: number,
): void {
	log.info(
		{
			event: "spawn.provisioned",
			sandbox_id: sandboxId,
			worker_id: workerId,
			duration_ms: Date.now() - startedAt,
		},
		"spawn: burrow provisioned",
	);
}

/** warren-c686: run dispatched onto the burrow, with dispatch latency. */
export function logDispatched(
	log: SpawnLogger,
	sandboxId: string,
	sandboxRunId: string,
	startedAt: number,
): void {
	log.info(
		{
			event: "spawn.dispatched",
			sandbox_id: sandboxId,
			sandbox_run_id: sandboxRunId,
			duration_ms: Date.now() - startedAt,
		},
		"spawn: run dispatched onto burrow",
	);
}

/** warren-c686: spawn failed past the warren-row point; about to roll back. */
export function logSpawnFailed(log: SpawnLogger, sandboxId: string | null, err: unknown): void {
	log.warn(
		{ event: "spawn.failed", sandbox_id: sandboxId, error: errorMessage(err) },
		"spawn: failed, rolling back",
	);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * warren-fc6e / pl-f700 step 2: persist a spawn failure durably so
 * RunDetail can surface the cause without a special case.
 *
 * Two writes, mirroring the `reap_failed` pattern:
 *
 *   1. Append a `spawn_failed` system event carrying `{ step, message,
 *      sandboxId? }`. The events pane's generic fallback renders the
 *      `message` field, so the cause shows up "for free" the same way a
 *      `reap_failed` step does.
 *   2. Finalize the run `failed` with `failure_reason = never_started`
 *      instead of a bare `cancelled` row — a spawn that never reached
 *      dispatch is, by definition, a run that never started. The row was
 *      created `queued`, so we walk `queued → running → failed` (the
 *      same shape reap's `transitionToTerminal` uses) because `finalize`
 *      only persists `failure_reason` on a `failed` transition and
 *      `queued → failed` is not an allowed edge.
 *
 * Both writes are best-effort: a failure here is logged but never masks
 * the original spawn error the caller is about to see rethrown.
 *
 * warren-c42c: no `sandboxId` rides the `spawn_failed` event — the runtime
 * seam (`RuntimeProvider.create()`) owns the sandbox and destroys any
 * partial provision itself, so the domain never learns a sandbox id on a
 * failed spawn (nor is one left stranded to reference).
 */
async function persistSpawnFailure(
	input: SpawnRunInput,
	runId: string,
	err: unknown,
	log: SpawnLogger,
): Promise<void> {
	const message = errorMessage(err);
	const now = input.now?.() ?? new Date();
	try {
		const seq = ((await input.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await input.repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: now.toISOString(),
			kind: "spawn_failed",
			stream: "system",
			payload: { step: "spawn", message },
		});
	} catch (eventErr) {
		log.error(
			{ event: "spawn.rollback.event_append_failed", error: errorMessage(eventErr) },
			"spawn rollback: spawn_failed event append failed",
		);
	}
	try {
		const current = await input.repos.runs.require(runId);
		// queued → running → failed: finalize only persists failure_reason
		// on a `failed` row, and queued → failed is not an allowed edge.
		if (current.state === "queued") {
			await input.repos.runs.markRunning(runId, now);
		}
		await input.repos.runs.finalize(runId, "failed", now, "never_started");
	} catch (finalizeErr) {
		// Either the row was already terminal (shouldn't happen on this path)
		// or the db handle is gone — either way, nothing to recover here.
		// warren-c686: previously swallowed silently; surface it so a stuck
		// `queued` row left behind by a failed finalize is debuggable.
		log.error(
			{ event: "spawn.rollback.finalize_failed", error: errorMessage(finalizeErr) },
			"spawn rollback: runs.finalize failed",
		);
	}
}

/**
 * Unwind a failed spawn (warren-c42c). Purely the domain-row unwind now:
 * `persistSpawnFailure` lands the `spawn_failed` event + the
 * `failed`/`never_started` finalize. The burrow-half teardown that used to
 * live here moved behind the runtime seam — `RuntimeProvider.create()` owns
 * destroying a sandbox it provisioned before a partial-failure rethrow — so
 * there is no sandbox for the domain to reference or destroy here.
 */
export async function rollback(
	input: SpawnRunInput,
	runId: string,
	log: SpawnLogger,
	err: unknown,
): Promise<void> {
	await persistSpawnFailure(input, runId, err, log);
}

/**
 * Single-local-burrow helpers (pl-829f phase RETIRE / warren-76c5).
 *
 * The multi-worker `BurrowClientPool` (pool.ts), fan-out (fanout.ts), and
 * placement (`src/runs/placement.ts`) layers were retired with the K8s
 * migration: warren's self-host backend is exactly ONE local burrow, so there
 * is nothing to place onto and nothing to fan out across. `LocalProvider`
 * (src/runtime/local/provider.ts) now wraps a single {@link BurrowClient}
 * directly.
 *
 * Two vestigial names survive this deletion because the `workers` table + the
 * `runs.worker_id` column live on until step 24 (warren-3743) and step 23
 * (warren-288f) removes the /workers admin surface:
 *
 *   - {@link LOCAL_WORKER_NAME} — the name the single local burrow is recorded
 *     under (`runs.worker_id` / `burrows.worker_id`); the preview proxy still
 *     reads it to decide "same host" (always true now).
 *   - {@link probeBurrowClient} — a `/healthz` probe over the one client,
 *     shaped as the old `ProbeResult` so `/readyz`, the boot probe, the worker
 *     probe loop, and diagnostics keep their wire/log output.
 */

import { LOCAL_WORKER_NAME } from "../runs/worker-identity.ts";
import type { BurrowClient } from "./client.ts";

/**
 * Name the single local burrow is recorded under in the `workers` /
 * `burrows` tables and `runs.worker_id`. The canonical definition lives in
 * the neutral `src/runs/worker-identity.ts` (warren-e24d) so the preview
 * subsystem can read it without importing `burrow-client`; re-exported here so
 * existing `burrow-client` importers are unchanged.
 */
export { LOCAL_WORKER_NAME };

/** One health-probe outcome for the single local burrow. */
export interface ProbeResult {
	readonly workerName: string;
	readonly ok: boolean;
	readonly error?: Error;
}

/**
 * Probe the single local burrow's `/healthz`. Never throws — a transport
 * failure lands as `{ ok: false, error }` so callers (`/readyz`, the boot
 * probe, the worker-probe loop, diagnostics) can surface a degraded backend
 * without aborting. Mirrors the old `BurrowClientPool.probe()` result shape
 * for exactly one worker.
 */
export async function probeBurrowClient(
	client: BurrowClient,
	timeoutMs?: number,
): Promise<ProbeResult> {
	try {
		await (timeoutMs !== undefined ? client.probe(timeoutMs) : client.probe());
		return { workerName: LOCAL_WORKER_NAME, ok: true };
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		return { workerName: LOCAL_WORKER_NAME, ok: false, error };
	}
}

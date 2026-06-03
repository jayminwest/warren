/**
 * Fan-out reads across every worker in a {@link BurrowClientPool}
 * (warren-14ad / pl-9ba1 step 5, parent warren-6747).
 *
 * Reads that are not scoped to a single burrow (today: `burrows.list`)
 * cannot use the sticky-by-burrow `pool.clientFor({burrowId})` path —
 * the burrow does not exist yet from the caller's POV. Instead they fan
 * out: ask every registered worker the same question in parallel, collect
 * the successes, surface the per-worker failures separately, and let the
 * caller compose the union.
 *
 * The helper is intentionally generic. Callers pass a per-worker async
 * function (`fn(client, workerName)`) and get back two arrays:
 *
 *   - `results` — one `{ workerName, value }` entry per fulfilled call,
 *     in pool name order. The caller decides whether to flatten,
 *     dedupe, or sort.
 *   - `errors` — one `{ workerName, error }` entry per rejected call,
 *     in pool name order. A best-effort `worker_unreachable` log line
 *     fires for each via the optional `logger.warn` hook, so operators
 *     see a structured trace of which workers fell out of the fan-out
 *     (plan acceptance #4).
 *
 * `Promise.allSettled` is the right primitive here: one slow or down
 * worker should not prevent warren from serving partial results. The
 * caller may surface the partial-failure set on the wire (e.g. a
 * `worker_errors` envelope alongside the union), or it may swallow them
 * — that policy lives at the handler, not in this helper.
 *
 * Per-resource reads (`burrows.get(id)`, `runs.get(id)`, run-event
 * streaming) do NOT fan out — they use `pool.clientFor({burrowId})` so
 * the request goes to exactly the worker that holds that burrow's
 * sandbox + SQLite row. Sticky-by-burrow is the contract there; a fan-out
 * would mask placement drift instead of surfacing it.
 *
 * Note: this module deliberately stays burrow-agnostic — it takes any
 * `BurrowClient` and any async function. The endpoint glue (e.g.
 * `GET /burrows` in `server/handlers/burrows.ts`) layers domain shape on top
 * (`http.burrows.list()` + `withTransportMapping` + createdAt sort).
 */

import type { BurrowClient } from "./client.ts";
import type { BurrowClientPool } from "./pool.ts";

/**
 * Pino-shaped logger subset. Loose enough that warren's pino logger and
 * test stubs both satisfy it; the helper only ever calls `warn` for
 * worker_unreachable surfaces.
 */
export interface FanOutLogger {
	warn?(obj: object, msg?: string): void;
}

export interface FanOutOptions {
	/**
	 * Where to emit `worker_unreachable` log lines. One entry per rejected
	 * worker; the line carries `{ workerName, op, err }` so operators can
	 * grep for a specific worker's drop-outs in a fan-out endpoint. Omit
	 * to silence the helper (tests).
	 */
	readonly logger?: FanOutLogger;
	/**
	 * Optional operation label included in the log line and in error
	 * messages (e.g. "burrows.list"). Purely diagnostic; nothing inside
	 * the helper branches on it.
	 */
	readonly op?: string;
}

export interface FanOutResult<T> {
	/** Fulfilled per-worker calls, in pool name order. */
	readonly results: ReadonlyArray<{ readonly workerName: string; readonly value: T }>;
	/** Rejected per-worker calls, in pool name order. Always-Error normalized. */
	readonly errors: ReadonlyArray<{ readonly workerName: string; readonly error: Error }>;
}

/**
 * Run `fn` against every registered client in `pool` in parallel via
 * `Promise.allSettled`. See module doc for the rationale and contract.
 *
 * Iteration order is `pool.names()` (alphabetical), so the result arrays
 * are deterministic — the caller can sort downstream by domain field
 * (e.g. `createdAt`) without depending on JS Map insertion order.
 */
export async function fanOutAcrossWorkers<T>(
	pool: BurrowClientPool,
	fn: (client: BurrowClient, workerName: string) => Promise<T>,
	opts: FanOutOptions = {},
): Promise<FanOutResult<T>> {
	const names = pool.names();
	const entries: ReadonlyArray<readonly [string, BurrowClient]> = names.map((name) => [
		name,
		pool.get(name),
	]);
	const settled = await Promise.allSettled(entries.map(([name, client]) => fn(client, name)));

	const results: { workerName: string; value: T }[] = [];
	const errors: { workerName: string; error: Error }[] = [];

	for (let i = 0; i < settled.length; i++) {
		const entry = entries[i];
		const outcome = settled[i];
		if (entry === undefined || outcome === undefined) continue;
		const workerName = entry[0];
		if (outcome.status === "fulfilled") {
			results.push({ workerName, value: outcome.value });
			continue;
		}
		const error =
			outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
		errors.push({ workerName, error });
		opts.logger?.warn?.(
			{
				workerName,
				op: opts.op,
				err: error.message,
			},
			"worker_unreachable",
		);
	}

	return { results, errors };
}

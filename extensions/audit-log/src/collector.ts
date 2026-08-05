/**
 * The collector: poll `GET /runs`, tail each run's events from its durable
 * cursor, hand every event to the sink in seq order, checkpoint after the
 * sink accepts.
 *
 * Delivery guarantee: AT-LEAST-ONCE. The cursor advances only after
 * `sink.apply` resolves, so a kill between apply and checkpoint — or a
 * sink failure mid-page — replays the un-checkpointed tail next cycle.
 * The sink MUST be idempotent (plan step 3); this module guarantees no
 * loss and no skips, not exactly-once.
 *
 * Sequencing is deliberately serial for v0: one run at a time, one page
 * at a time. FRICTION §1 records the cost model — per-run polling is
 * O(active runs) requests per cycle because warren has no global stream.
 */

import { listRuns, readEventsSince, type WarrenClient } from "./client.ts";
import type { CursorStore } from "./cursor-store.ts";
import { type RunEvent, type RunListRow, isTerminalRunState } from "./wire.ts";

/** Where collected events go. The audit store (step 3) implements this. */
export interface EventSink {
	apply(event: RunEvent): void | Promise<void>;
	/**
	 * Called once per discovered run per cycle, after the run's tail
	 * drains. List-derived facts (run.dispatched for zero-event runs,
	 * run.terminal for terminal states) ride this hook — the event
	 * stream alone never states them (FRICTION §1).
	 */
	observeRun?(run: RunListRow): void | Promise<void>;
}

export interface CollectorDeps {
	readonly client: WarrenClient;
	readonly store: CursorStore;
	readonly sink: EventSink;
	/** Events fetched per tail page (server accepts any positive int). */
	readonly eventsPageSize?: number;
	/** Runs fetched per discovery page (server caps at 500). */
	readonly runsPageSize?: number;
	/** Injectable for tests. */
	readonly now?: () => Date;
	/** Per-run failures land here; the cycle continues with the next run. */
	readonly onRunError?: (runId: string, err: unknown) => void;
}

export interface CycleStats {
	readonly runsDiscovered: number;
	readonly runsTailed: number;
	readonly eventsApplied: number;
}

const DEFAULT_EVENTS_PAGE_SIZE = 500;
const DEFAULT_RUNS_PAGE_SIZE = 500;

/**
 * Discover every run by paging the full list from offset 0. FRICTION §1:
 * no "changed since" parameter exists, so this is a full re-list every
 * cycle, and offset-paging over a moving `started desc` list can skip or
 * re-see a row mid-page — harmless here because tailed state is keyed by
 * run id and the next cycle re-lists from scratch.
 */
async function discoverRuns(
	client: WarrenClient,
	pageSize: number,
): Promise<RunListRow[]> {
	const runs: RunListRow[] = [];
	let offset = 0;
	while (true) {
		const page = await listRuns(client, { limit: pageSize, offset });
		runs.push(...page.runs);
		if (page.runs.length < pageSize) return runs;
		offset += page.runs.length;
	}
}

/**
 * Drain one run's tail from its cursor. Applies events in seq order,
 * checkpointing after each. Returns the number of events applied.
 * Terminal runs fully caught up are marked drained so later cycles skip
 * them entirely.
 */
async function tailRun(
	run: RunListRow,
	deps: CollectorDeps,
	pageSize: number,
	now: () => Date,
): Promise<number> {
	const cursor = deps.store.get(run.id);
	if (cursor.drained) return 0;

	let since = cursor.lastSeq;
	let applied = 0;
	while (true) {
		const events = await readEventsSince(deps.client, run.id, {
			since,
			limit: pageSize,
		});
		for (const event of events) {
			await deps.sink.apply(event);
			deps.store.checkpoint(run.id, event.seq, run.state, false, now().toISOString());
			since = event.seq;
			applied += 1;
		}
		if (events.length < pageSize) break;
	}
	if (isTerminalRunState(run.state)) {
		deps.store.checkpoint(run.id, since, run.state, true, now().toISOString());
	}
	return applied;
}

/** One full poll cycle: discover, then tail every run. */
export async function collectOnce(deps: CollectorDeps): Promise<CycleStats> {
	const now = deps.now ?? (() => new Date());
	const eventsPageSize = deps.eventsPageSize ?? DEFAULT_EVENTS_PAGE_SIZE;
	const runs = await discoverRuns(deps.client, deps.runsPageSize ?? DEFAULT_RUNS_PAGE_SIZE);

	let runsTailed = 0;
	let eventsApplied = 0;
	for (const run of runs) {
		try {
			const applied = await tailRun(run, deps, eventsPageSize, now);
			// After the tail, so an event-derived terminal fact (reap.completed)
			// wins the dedupe race over the list-derived one below.
			await deps.sink.observeRun?.(run);
			runsTailed += 1;
			eventsApplied += applied;
		} catch (err) {
			// Per-run isolation: one failing tail (404 race, drifted event,
			// sink error) must not starve the others. The cursor did not
			// advance past the failure, so the next cycle resumes exactly
			// where this one stopped.
			deps.onRunError?.(run.id, err);
		}
	}
	return { runsDiscovered: runs.length, runsTailed, eventsApplied };
}

export interface RunCollectorOptions extends CollectorDeps {
	readonly pollIntervalMs: number;
	readonly signal?: AbortSignal;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Cycle-level failures (discovery unreachable) land here. */
	readonly onCycleError?: (err: unknown) => void;
	/** After every completed cycle — the health surface's liveness feed. */
	readonly onCycle?: (stats: CycleStats) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The collector loop: cycle, sleep, repeat until the signal aborts. */
export async function runCollector(opts: RunCollectorOptions): Promise<void> {
	const sleep = opts.sleep ?? defaultSleep;
	while (opts.signal?.aborted !== true) {
		try {
			const stats = await collectOnce(opts);
			opts.onCycle?.(stats);
		} catch (err) {
			opts.onCycleError?.(err);
		}
		await sleep(opts.pollIntervalMs);
	}
}

/**
 * Plan-run event tail (warren-e240 / pl-882c step 8).
 *
 * Moved out of `src/server/handlers/plan-runs.ts`. Tail the union of every
 * plan-run child's events: history first (via `events.listByRunIds`), then
 * live arrivals from `broker.subscribe(runId)` for each known child runId.
 * Newly-dispatched children are picked up by a polling watcher so a stream
 * opened before child 2 lands still sees its events without a reconnect.
 *
 * Live events are deduped by (runId, sandboxEventSeq) against the high-water
 * mark established during history replay, so a row that lands in the gap
 * between snapshot and subscribe isn't either dropped or duplicated.
 */

import type { Repos } from "../db/repos/index.ts";
import type { EventRow } from "../db/schema.ts";
import type { RunEventBroker } from "../runs/index.ts";

export interface TailPlanRunEventsInput {
	readonly planRunId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly follow: boolean;
	readonly signal: AbortSignal;
}

export type PlanRunEventRow = EventRow;

const WATCHER_INTERVAL_MS = 2_000;

export async function* tailPlanRunEvents(
	input: TailPlanRunEventsInput,
): AsyncGenerator<PlanRunEventRow, void, void> {
	const seenSeq = new Map<string, number>();

	const initialChildren = await input.repos.planRuns.listChildren(input.planRunId);
	const initialRunIds = initialChildren.map((c) => c.runId).filter((v): v is string => v !== null);
	const history = await input.repos.events.listByRunIds(initialRunIds);
	for (const row of history) {
		const prev = seenSeq.get(row.runId) ?? 0;
		if (row.sandboxEventSeq > prev) seenSeq.set(row.runId, row.sandboxEventSeq);
		yield row;
	}

	if (!input.follow) return;

	// Shared event queue fed by every per-child subscription pump.
	const queue: PlanRunEventRow[] = [];
	let waiter: (() => void) | null = null;
	const wake = (): void => {
		const fn = waiter;
		if (fn !== null) {
			waiter = null;
			fn();
		}
	};
	input.signal.addEventListener("abort", wake, { once: true });

	const subscribed = new Set<string>();
	const subscribe = (runId: string): void => {
		if (subscribed.has(runId)) return;
		subscribed.add(runId);
		const sub = input.broker.subscribe(runId, { signal: input.signal });
		void (async () => {
			try {
				for await (const row of sub) {
					queue.push(row as PlanRunEventRow);
					wake();
				}
			} catch {
				// broker.subscribe ends via signal abort or close — ignore.
			}
		})();
	};
	for (const runId of initialRunIds) subscribe(runId);

	const watcher = setInterval(() => {
		void (async () => {
			try {
				const fresh = await input.repos.planRuns.listChildren(input.planRunId);
				for (const child of fresh) {
					if (child.runId !== null) subscribe(child.runId);
				}
			} catch {
				// Best-effort — a missed reload pings again next tick.
			}
		})();
	}, WATCHER_INTERVAL_MS);

	try {
		while (!input.signal.aborted) {
			const row = queue.shift();
			if (row === undefined) {
				await new Promise<void>((resolve) => {
					waiter = resolve;
				});
				continue;
			}
			const prev = seenSeq.get(row.runId) ?? 0;
			if (row.sandboxEventSeq <= prev) continue;
			seenSeq.set(row.runId, row.sandboxEventSeq);
			yield row;
		}
	} finally {
		clearInterval(watcher);
	}
}

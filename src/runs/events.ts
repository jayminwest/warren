/**
 * Warren's run-event fan-out (docs/design/agent-composition.md step 5; event durability per docs/design/runtime-and-supervisor.md).
 *
 * Two surfaces live here:
 *
 *   `RunEventBroker` — in-memory pub/sub keyed by warren run id. The
 *      bridge in `./stream.ts` writes each event to the `events` table
 *      first, then `publish()`es to the broker so currently-attached
 *      subscribers see live events. Subscribers are async generators;
 *      each has its own bounded queue so a slow consumer cannot block
 *      the bridge or other consumers.
 *
 *   `tailRunEvents` — replay history then live-tail. The HTTP
 *      `/runs/:id/events?follow=1` route serves this generator: history
 *      comes from `EventsRepo.listByRun`, live events come from the
 *      broker subscription. Subscription is opened **before** history
 *      is read so events arriving in the gap aren't dropped; the
 *      handoff dedupes by `sandbox_event_seq` so subscribers don't see
 *      the same row twice.
 *
 * The broker is intentionally not durable. Burrow owns the canonical
 * event log; warren's events table is the recovery boundary if warren
 * restarts. The broker holds nothing the events table doesn't already
 * have.
 */

import type { EventsRepo } from "../db/repos/events.ts";
import type { EventRow } from "../db/schema.ts";

/**
 * Per-subscriber bounded buffer with a Promise-based notify primitive.
 * The bridge calls `push` from the stream pump; the subscriber's async
 * generator awaits the promise when the queue drains. AbortSignal
 * cleanly resolves the waiter and ends the generator.
 *
 * Queue cap defaults to 1024 — well above any realistic burst the run
 * loop emits, low enough that a stuck consumer surfaces as a `dropped`
 * counter rather than unbounded memory growth.
 */
interface Subscription {
	push(event: EventRow): void;
	end(): void;
	readonly dropped: () => number;
}

export interface SubscribeOptions {
	readonly signal?: AbortSignal;
	/** Maximum buffered events before the broker starts dropping (FIFO). */
	readonly bufferSize?: number;
}

export const DEFAULT_SUBSCRIPTION_BUFFER = 1024;

export class RunEventBroker {
	private readonly subs = new Map<string, Set<Subscription>>();

	/**
	 * Push an event to every active subscriber for `runId`. Called by the
	 * bridge after the event is durably written. No-op when no one is
	 * listening — the events table is the recovery surface for late
	 * subscribers.
	 */
	publish(runId: string, event: EventRow): void {
		const set = this.subs.get(runId);
		if (!set) return;
		for (const sub of set) sub.push(event);
	}

	/**
	 * Signal end-of-stream to every active subscriber for `runId`. The
	 * bridge calls this when the burrow stream returns (run terminated)
	 * or the bridge is being torn down. Subscribers' generators return
	 * after draining their buffer.
	 */
	close(runId: string): void {
		const set = this.subs.get(runId);
		if (!set) return;
		for (const sub of set) sub.end();
		this.subs.delete(runId);
	}

	/** Test/diagnostic surface — number of currently-attached subscribers. */
	subscriberCount(runId: string): number {
		return this.subs.get(runId)?.size ?? 0;
	}

	/**
	 * Open a live subscription. Yields events the bridge publishes after
	 * the call returns; events that landed before are still in the events
	 * table — combine via `tailRunEvents`. Cancellation via `signal`
	 * cleanly ends the generator after the current buffered event is
	 * yielded; ending the generator (consumer breaks out) detaches the
	 * subscription synchronously.
	 */
	subscribe(runId: string, opts: SubscribeOptions = {}): AsyncGenerator<EventRow, void, void> {
		const bufferSize = opts.bufferSize ?? DEFAULT_SUBSCRIPTION_BUFFER;
		const sub = createSubscription(bufferSize);
		this.attach(runId, sub.controller);
		return this.consume(runId, sub, opts.signal);
	}

	private attach(runId: string, sub: Subscription): void {
		let set = this.subs.get(runId);
		if (!set) {
			set = new Set();
			this.subs.set(runId, set);
		}
		set.add(sub);
	}

	private detach(runId: string, sub: Subscription): void {
		const set = this.subs.get(runId);
		if (!set) return;
		set.delete(sub);
		if (set.size === 0) this.subs.delete(runId);
	}

	private async *consume(
		runId: string,
		sub: { controller: Subscription; iterator: AsyncGenerator<EventRow, void, void> },
		signal: AbortSignal | undefined,
	): AsyncGenerator<EventRow, void, void> {
		const onAbort = (): void => sub.controller.end();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) sub.controller.end();
		try {
			for await (const ev of sub.iterator) yield ev;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.detach(runId, sub.controller);
		}
	}
}

/** Build a subscription pair: a push controller and a consumer generator. */
function createSubscription(bufferSize: number): {
	controller: Subscription;
	iterator: AsyncGenerator<EventRow, void, void>;
} {
	const queue: EventRow[] = [];
	let waiter: (() => void) | null = null;
	let ended = false;
	let dropped = 0;

	const wake = (): void => {
		if (waiter) {
			const fn = waiter;
			waiter = null;
			fn();
		}
	};

	const controller: Subscription = {
		push(event) {
			if (ended) return;
			if (queue.length >= bufferSize) {
				queue.shift();
				dropped += 1;
			}
			queue.push(event);
			wake();
		},
		end() {
			ended = true;
			wake();
		},
		dropped: () => dropped,
	};

	async function* iterator(): AsyncGenerator<EventRow, void, void> {
		while (true) {
			const next = queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (ended) return;
			await new Promise<void>((resolve) => {
				waiter = resolve;
			});
		}
	}

	return { controller, iterator: iterator() };
}

export interface TailRunEventsInput {
	readonly runId: string;
	readonly repos: { events: EventsRepo };
	readonly broker: RunEventBroker;
	/**
	 * `true`: replay history then keep yielding live events until the
	 * broker closes the run or the signal aborts.
	 * `false`: replay history and return.
	 */
	readonly follow: boolean;
	/** Skip events with `sandbox_event_seq <= sinceSeq`. Default: 0 (all). */
	readonly sinceSeq?: number;
	readonly signal?: AbortSignal;
	/**
	 * Max rows a single `listByRun` snapshot materializes (warren-2a8b).
	 * Default `DEFAULT_SNAPSHOT_PAGE_LIMIT`. Non-follow tails return one
	 * page and rely on the client re-querying with `?since`; follow tails
	 * page forward through history in chunks of this size so per-query
	 * memory stays bounded without truncating the replay.
	 */
	readonly snapshotLimit?: number;
	/**
	 * Terminal backstop (warren-7bff). `broker.close(runId)` only fires
	 * while a stream bridge is alive for the run; a follow tail opened
	 * against a run whose bridge already exited (warren restart, finalize
	 * racing the connect) would otherwise hang forever. When provided,
	 * `isTerminal` is polled (once immediately, then every `pollMs`); on
	 * the first `true` the tail drains any events persisted since the last
	 * yield and returns. Read failures are treated as transient — the tail
	 * keeps following and the next tick retries.
	 */
	readonly terminal?: {
		readonly isTerminal: () => Promise<boolean>;
		readonly pollMs?: number;
	};
}

/** Default interval for the terminal backstop poll (warren-7bff). */
export const DEFAULT_TERMINAL_POLL_MS = 1000;

/**
 * Default snapshot page size (warren-2a8b). Anonymous event replays must
 * not materialize an entire run transcript per connection — the pod runs
 * a single replica under a 1Gi limit, so a handful of concurrent replays
 * of a long run could OOM-kill it. Clients page beyond the bound with
 * `?since`.
 */
export const DEFAULT_SNAPSHOT_PAGE_LIMIT = 5000;

/**
 * Replay-then-live tail for `/runs/:id/events?follow=1`. Subscribes to
 * the broker first, snapshots the events table, yields the snapshot,
 * then yields live events while skipping any whose seq is at-or-below
 * the highest seq the snapshot already covered. Without that ordering,
 * an event committed-but-not-yet-published between the listByRun call
 * and the subscribe would either be dropped (subscribe-after-listByRun
 * naive) or duplicated (no dedup).
 */
export async function* tailRunEvents(
	input: TailRunEventsInput,
): AsyncGenerator<EventRow, void, void> {
	const { runId, repos, follow } = input;
	const sinceSeq = input.sinceSeq ?? 0;

	const snapshotLimit = input.snapshotLimit ?? DEFAULT_SNAPSHOT_PAGE_LIMIT;

	if (!follow) {
		// One bounded page; the client pages beyond it with `?since`.
		const opts = sinceSeq > 0 ? { sinceSeq, limit: snapshotLimit } : { limit: snapshotLimit };
		for (const row of await repos.events.listByRun(runId, opts)) yield row;
		return;
	}
	yield* followRunEvents(input, sinceSeq);
}

/**
 * The follow half of `tailRunEvents`: replay the snapshot, live-tail the
 * broker, and — when a terminal probe is wired — end promptly once the
 * run finishes even if no bridge remains to `broker.close` it.
 */
async function* followRunEvents(
	input: TailRunEventsInput,
	sinceSeq: number,
): AsyncGenerator<EventRow, void, void> {
	const { runId, repos, broker, signal } = input;

	// Linked abort for the subscription: fires when the caller's signal
	// aborts OR when the terminal backstop trips. Waking the subscription
	// this way (rather than racing `live.next()` against a terminal
	// promise) is what lets `live.return()` in the finally settle — a
	// generator parked in the subscription's notify-await cannot be
	// interrupted by `.return()` alone.
	const subCtrl = new AbortController();
	const onCallerAbort = (): void => subCtrl.abort();
	if (signal !== undefined) {
		if (signal.aborted) subCtrl.abort();
		else signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	const live = broker.subscribe(runId, { signal: subCtrl.signal });

	const backstop =
		input.terminal !== undefined
			? startTerminalBackstop(input.terminal, () => subCtrl.abort())
			: null;

	const listOpts =
		sinceSeq > 0
			? { sinceSeq, limit: input.snapshotLimit ?? DEFAULT_SNAPSHOT_PAGE_LIMIT }
			: { limit: input.snapshotLimit ?? DEFAULT_SNAPSHOT_PAGE_LIMIT };
	let lastYielded = sinceSeq;
	try {
		lastYielded = yield* pageHistory(repos, runId, listOpts, lastYielded);
		lastYielded = yield* yieldNewerRows(live, lastYielded);
		if (backstop?.reached() === true && !signal?.aborted) {
			// The backstop (not `broker.close`) ended the tail, so events
			// committed-but-never-published may still sit in the table.
			// Drain them before closing so the follow tail doesn't truncate
			// the run's final events.
			const drainOpts = lastYielded > 0 ? { sinceSeq: lastYielded } : {};
			lastYielded = yield* yieldNewerRows(
				await repos.events.listByRun(runId, drainOpts),
				lastYielded,
			);
		}
	} finally {
		if (backstop !== null) clearInterval(backstop.timer);
		signal?.removeEventListener("abort", onCallerAbort);
		await live.return(undefined).catch(() => {});
	}
}

/**
 * Page forward through history in bounded chunks (warren-2a8b). A
 * follow client can't re-issue `?since` mid-stream, so truncating the
 * snapshot would silently drop events between its last row and the live
 * tail; paging keeps the full replay while bounding each materialization.
 * A short page means the snapshot is exhausted. Returns the high-water
 * mark via the generator return value, like `yieldNewerRows`.
 */
async function* pageHistory(
	repos: { events: EventsRepo },
	runId: string,
	listOpts: { sinceSeq?: number; limit: number },
	lastYielded: number,
): AsyncGenerator<EventRow, number, void> {
	let last = lastYielded;
	let page = await repos.events.listByRun(runId, listOpts);
	while (page.length > 0) {
		last = yield* yieldNewerRows(page, last);
		if (page.length < listOpts.limit) break;
		page = await repos.events.listByRun(runId, { sinceSeq: last, limit: listOpts.limit });
	}
	return last;
}

/**
 * Yield every row whose `sandboxEventSeq` is above `lastYielded`, returning
 * the new high-water mark via the generator's return value (`yield*`
 * captures it). Shared by the snapshot replay, the live tail and the
 * terminal drain so the dedup rule lives in exactly one place.
 */
async function* yieldNewerRows(
	rows: Iterable<EventRow> | AsyncIterable<EventRow>,
	lastYielded: number,
): AsyncGenerator<EventRow, number, void> {
	let last = lastYielded;
	for await (const row of rows) {
		if (row.sandboxEventSeq <= last) continue;
		yield row;
		last = row.sandboxEventSeq;
	}
	return last;
}

interface TerminalBackstop {
	readonly timer: ReturnType<typeof setInterval>;
	readonly reached: () => boolean;
}

/**
 * Poll `probe.isTerminal` (once immediately, then every `pollMs`) and fire
 * `onTerminal` on the first `true`. Read failures are transient — the tail
 * keeps following and the next tick retries.
 */
function startTerminalBackstop(
	probe: { isTerminal: () => Promise<boolean>; pollMs?: number },
	onTerminal: () => void,
): TerminalBackstop {
	let hit = false;
	const check = (): void => {
		probe
			.isTerminal()
			.then((terminal) => {
				if (!terminal) return;
				hit = true;
				onTerminal();
			})
			.catch(() => {});
	};
	check();
	return {
		timer: setInterval(check, probe.pollMs ?? DEFAULT_TERMINAL_POLL_MS),
		reached: () => hit,
	};
}

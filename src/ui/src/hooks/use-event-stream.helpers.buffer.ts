import type { RunEvent } from "../api/types.ts";

/**
 * The bounded, seq-ordered event buffer behind `useEventStream`
 * (warren-4a47). The old hook appended with `[...s.events, evt]` per
 * event, an O(n) copy for every line of a long run with no ceiling, and
 * the log re-sorted the whole array on every render. This module keeps
 * the buffer sorted by `seq` as it grows, so readers never sort:
 *
 *   - in-order arrivals (the normal case) append in one concat per batch;
 *   - a late or replayed event binary-searches its slot, and a seq the
 *     buffer already holds is dropped (reconnect overlap);
 *   - past `max` events the oldest are dropped in `trimStep` blocks, so
 *     the trim (which shifts every index) happens once per block, not per
 *     event. `trimmed` counts what was dropped so the log can say so.
 */

export const EVENT_BUFFER_MAX = 5000;
export const EVENT_BUFFER_TRIM_STEP = 500;

export interface EventBuffer {
	readonly events: RunEvent[];
	/** Events dropped off the front to hold the ceiling. */
	readonly trimmed: number;
}

export const EMPTY_EVENT_BUFFER: EventBuffer = { events: [], trimmed: 0 };

/** Index of the first event whose seq is >= `seq` (lower bound). */
export function lowerBoundBySeq(events: readonly RunEvent[], seq: number): number {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const e = events[mid];
		if (e !== undefined && e.seq < seq) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Insert out-of-order events into a sorted copy; drops seqs already held. */
function insertLate(base: RunEvent[], late: readonly RunEvent[]): RunEvent[] {
	let out = base;
	for (const evt of late) {
		const at = lowerBoundBySeq(out, evt.seq);
		if (out[at]?.seq === evt.seq) continue;
		if (out === base) out = base.slice();
		out.splice(at, 0, evt);
	}
	return out;
}

/** Split a batch into the in-order tail and the stragglers that need a slot. */
function partitionBatch(
	lastSeq: number,
	incoming: readonly RunEvent[],
): { tail: RunEvent[]; late: RunEvent[] } {
	const tail: RunEvent[] = [];
	const late: RunEvent[] = [];
	let high = lastSeq;
	for (const evt of incoming) {
		if (evt.seq > high) {
			tail.push(evt);
			high = evt.seq;
		} else {
			late.push(evt);
		}
	}
	return { tail, late };
}

export function appendEvents(
	buf: EventBuffer,
	incoming: readonly RunEvent[],
	max: number = EVENT_BUFFER_MAX,
	trimStep: number = EVENT_BUFFER_TRIM_STEP,
): EventBuffer {
	if (incoming.length === 0) return buf;
	const lastSeq = buf.events[buf.events.length - 1]?.seq ?? Number.NEGATIVE_INFINITY;
	const { tail, late } = partitionBatch(lastSeq, incoming);
	let events = tail.length > 0 ? buf.events.concat(tail) : buf.events;
	if (late.length > 0) events = insertLate(events, late);
	if (events === buf.events) return buf;
	if (events.length <= max) return { events, trimmed: buf.trimmed };
	const keep = Math.max(1, max - trimStep);
	const drop = events.length - keep;
	return { events: events.slice(drop), trimmed: buf.trimmed + drop };
}

/**
 * Coalesce items arriving in the same animation frame into one flush.
 * A background tab never fires `requestAnimationFrame`, so a timeout
 * backs it up: the buffer keeps draining (bounded) while the tab is
 * hidden. Scheduling primitives are injectable for tests.
 */
export interface FrameBatcherDeps {
	readonly requestFrame: (cb: () => void) => number;
	readonly cancelFrame: (id: number) => void;
	readonly setTimer: (cb: () => void, ms: number) => number;
	readonly clearTimer: (id: number) => void;
}

export const FRAME_BATCH_FALLBACK_MS = 250;

export interface FrameBatcher<T> {
	push: (item: T) => void;
	/** Deliver anything pending now (stream end, status change). */
	flush: () => void;
	/** Drop pending items and cancel timers (unmount). */
	cancel: () => void;
}

export function createFrameBatcher<T>(
	onFlush: (items: T[]) => void,
	deps: FrameBatcherDeps,
): FrameBatcher<T> {
	let pending: T[] = [];
	let frame: number | null = null;
	let timer: number | null = null;
	const clear = () => {
		if (frame !== null) deps.cancelFrame(frame);
		if (timer !== null) deps.clearTimer(timer);
		frame = null;
		timer = null;
	};
	const flush = () => {
		clear();
		if (pending.length === 0) return;
		const items = pending;
		pending = [];
		onFlush(items);
	};
	return {
		push: (item) => {
			pending.push(item);
			if (frame !== null) return;
			frame = deps.requestFrame(flush);
			timer = deps.setTimer(flush, FRAME_BATCH_FALLBACK_MS);
		},
		flush,
		cancel: () => {
			clear();
			pending = [];
		},
	};
}

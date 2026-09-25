import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../api/types.ts";
import {
	appendEvents,
	createFrameBatcher,
	EMPTY_EVENT_BUFFER,
	type FrameBatcherDeps,
	lowerBoundBySeq,
} from "./use-event-stream.helpers.buffer.ts";

function ev(seq: number): RunEvent {
	return {
		id: seq,
		runId: "run_x",
		seq,
		ts: "2026-09-25T10:00:00Z",
		kind: "text",
		stream: "stdout",
		payload: null,
	};
}

const seqs = (events: readonly RunEvent[]) => events.map((e) => e.seq);

describe("appendEvents", () => {
	test("appends an in-order batch without reordering", () => {
		const a = appendEvents(EMPTY_EVENT_BUFFER, [ev(1), ev(2)]);
		const b = appendEvents(a, [ev(3), ev(4)]);
		expect(seqs(b.events)).toEqual([1, 2, 3, 4]);
		expect(b.trimmed).toBe(0);
	});

	test("returns the same buffer for an empty or all-duplicate batch", () => {
		const a = appendEvents(EMPTY_EVENT_BUFFER, [ev(1), ev(2)]);
		expect(appendEvents(a, [])).toBe(a);
		expect(appendEvents(a, [ev(2), ev(1)])).toBe(a);
	});

	test("drops a replayed seq after a reconnect overlap", () => {
		const a = appendEvents(EMPTY_EVENT_BUFFER, [ev(1), ev(2), ev(3)]);
		const b = appendEvents(a, [ev(3), ev(4)]);
		expect(seqs(b.events)).toEqual([1, 2, 3, 4]);
	});

	test("slots a late event into seq order", () => {
		const a = appendEvents(EMPTY_EVENT_BUFFER, [ev(1), ev(4)]);
		const b = appendEvents(a, [ev(5), ev(2), ev(3)]);
		expect(seqs(b.events)).toEqual([1, 2, 3, 4, 5]);
	});

	test("does not mutate the previous buffer's array", () => {
		const a = appendEvents(EMPTY_EVENT_BUFFER, [ev(1), ev(3)]);
		const before = seqs(a.events);
		appendEvents(a, [ev(2)]);
		expect(seqs(a.events)).toEqual(before);
	});

	test("trims the oldest events in blocks once past the ceiling", () => {
		let buf = EMPTY_EVENT_BUFFER;
		for (let i = 1; i <= 10; i++) buf = appendEvents(buf, [ev(i)], 10, 4);
		expect(buf.events.length).toBe(10);
		expect(buf.trimmed).toBe(0);
		buf = appendEvents(buf, [ev(11)], 10, 4);
		expect(seqs(buf.events)).toEqual([6, 7, 8, 9, 10, 11]);
		expect(buf.trimmed).toBe(5);
		buf = appendEvents(buf, [ev(12)], 10, 4);
		expect(buf.events.length).toBe(7);
		expect(buf.trimmed).toBe(5);
	});
});

describe("lowerBoundBySeq", () => {
	test("finds the first slot at or after a seq", () => {
		const events = [ev(2), ev(4), ev(6)];
		expect(lowerBoundBySeq(events, 1)).toBe(0);
		expect(lowerBoundBySeq(events, 4)).toBe(1);
		expect(lowerBoundBySeq(events, 5)).toBe(2);
		expect(lowerBoundBySeq(events, 9)).toBe(3);
	});
});

function fakeScheduler() {
	const frames = new Map<number, () => void>();
	const timers = new Map<number, () => void>();
	let next = 1;
	const deps: FrameBatcherDeps = {
		requestFrame: (cb) => {
			frames.set(next, cb);
			return next++;
		},
		cancelFrame: (id) => frames.delete(id),
		setTimer: (cb) => {
			timers.set(next, cb);
			return next++;
		},
		clearTimer: (id) => timers.delete(id),
	};
	const runFrames = () => {
		for (const [id, cb] of [...frames]) {
			frames.delete(id);
			cb();
		}
	};
	const runTimers = () => {
		for (const [id, cb] of [...timers]) {
			timers.delete(id);
			cb();
		}
	};
	return { deps, frames, timers, runFrames, runTimers };
}

describe("createFrameBatcher", () => {
	test("coalesces pushes in one frame into one flush", () => {
		const s = fakeScheduler();
		const flushed: number[][] = [];
		const b = createFrameBatcher<number>((items) => flushed.push(items), s.deps);
		b.push(1);
		b.push(2);
		b.push(3);
		expect(s.frames.size).toBe(1);
		s.runFrames();
		expect(flushed).toEqual([[1, 2, 3]]);
		expect(s.timers.size).toBe(0);
	});

	test("the timeout drains when no frame fires (hidden tab)", () => {
		const s = fakeScheduler();
		const flushed: number[][] = [];
		const b = createFrameBatcher<number>((items) => flushed.push(items), s.deps);
		b.push(1);
		s.runTimers();
		expect(flushed).toEqual([[1]]);
		expect(s.frames.size).toBe(0);
	});

	test("flush delivers pending now and cancel drops it", () => {
		const s = fakeScheduler();
		const flushed: number[][] = [];
		const b = createFrameBatcher<number>((items) => flushed.push(items), s.deps);
		b.push(1);
		b.flush();
		b.push(2);
		b.cancel();
		s.runFrames();
		s.runTimers();
		expect(flushed).toEqual([[1]]);
	});
});

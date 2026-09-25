import { describe, expect, test } from "bun:test";
import {
	formatEventClock,
	formatEventWhen,
	sinceForPreset,
	streamToneClass,
	summarizeEventPayload,
	TIME_RANGES,
} from "./event-explorer-format.ts";

describe("summarizeEventPayload", () => {
	test("returns a string payload verbatim", () => {
		expect(summarizeEventPayload("git commit -m x")).toBe("git commit -m x");
	});

	test("prefers the narrative keys over field order", () => {
		expect(
			summarizeEventPayload({ state: "running", message: "queued → running", attempts: 2 }),
		).toBe("queued → running · running");
	});

	test("joins several narrative keys with a dot separator", () => {
		expect(summarizeEventPayload({ command: "bun test", exit: 0 })).toBe("bun test");
	});

	test("falls back to key=value scalars when no narrative key matches", () => {
		expect(summarizeEventPayload({ a: 1, b: true, c: "x", d: "y" })).toBe("a=1 · b=true · c=x");
	});

	test("truncates past the summary budget", () => {
		const out = summarizeEventPayload({ message: "x".repeat(400) });
		expect(out.length).toBe(160);
		expect(out.endsWith("…")).toBe(true);
	});

	test("marks absent payloads with a dash", () => {
		expect(summarizeEventPayload(null)).toBe("—");
		expect(summarizeEventPayload(undefined)).toBe("—");
		expect(summarizeEventPayload({})).toBe("{}");
	});

	test("stringifies arrays", () => {
		expect(summarizeEventPayload([])).toBe("[]");
		expect(summarizeEventPayload(["a"])).toBe('["a"]');
	});
});

describe("formatEventClock", () => {
	test("formats a parseable timestamp as local HH:MM:SS", () => {
		expect(formatEventClock("2026-08-26T14:36:54Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});

	test("passes an unparseable string through unchanged", () => {
		expect(formatEventClock("not-a-date")).toBe("not-a-date");
	});
});

describe("streamToneClass", () => {
	test("maps each stream to its token color", () => {
		expect(streamToneClass("stdout")).toBe("text-(--color-info)");
		expect(streamToneClass("stderr")).toBe("text-(--color-danger)");
		expect(streamToneClass("system")).toBe("text-(--color-text-2)");
		expect(streamToneClass(null)).toBe("text-(--color-text-3)");
	});
});

describe("sinceForPreset", () => {
	test("returns undefined only for the unbounded preset", () => {
		const all = TIME_RANGES.find((r) => r.id === "all");
		expect(all).toBeDefined();
		expect(sinceForPreset(all ?? { id: "all", label: "ALL", windowMs: null })).toBeUndefined();
		for (const preset of TIME_RANGES.filter((r) => r.windowMs !== null)) {
			const since = sinceForPreset(preset);
			expect(since).toBeDefined();
			expect(Number.isNaN(new Date(since ?? "").getTime())).toBe(false);
		}
	});
});

describe("formatEventWhen", () => {
	test("shows only the clock for an event from today", () => {
		const now = new Date(2026, 8, 25, 15, 0, 0).getTime();
		const ts = new Date(2026, 8, 25, 9, 11, 10).toISOString();
		expect(formatEventWhen(ts, now)).toBe("09:11:10");
	});
	test("adds the date for an older event", () => {
		const now = new Date(2026, 8, 25, 15, 0, 0).getTime();
		const ts = new Date(2026, 8, 22, 9, 11, 10).toISOString();
		expect(formatEventWhen(ts, now)).toBe("Sep 22, 09:11");
	});
	test("returns an unparseable timestamp unchanged", () => {
		expect(formatEventWhen("not-a-date", 0)).toBe("not-a-date");
	});
});

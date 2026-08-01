import { describe, expect, test } from "bun:test";
import {
	ANALYTICS_DEFAULT_WINDOW_DAYS,
	ANALYTICS_MAX_WINDOW_DAYS,
	resolveAnalyticsWindow,
} from "./runs/lifecycle.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveAnalyticsWindow", () => {
	test("defaults from to 30 days back and to to now when neither bound is supplied", () => {
		const before = Date.now();
		const w = resolveAnalyticsWindow(undefined, undefined);
		const after = Date.now();
		const fromMs = Date.parse(w.from);
		const toMs = Date.parse(w.to);
		expect(toMs).toBeGreaterThanOrEqual(before);
		expect(toMs).toBeLessThanOrEqual(after);
		expect(toMs - fromMs).toBe(ANALYTICS_DEFAULT_WINDOW_DAYS * DAY_MS);
	});

	test("applies the 30-day default window when to= is present and from is absent (warren-30cc)", () => {
		const to = "2030-01-01T00:00:00.000Z";
		const w = resolveAnalyticsWindow(undefined, to);
		expect(w.to).toBe(to);
		expect(Date.parse(to) - Date.parse(w.from)).toBe(ANALYTICS_DEFAULT_WINDOW_DAYS * DAY_MS);
	});

	test("keeps explicit bounds when both are supplied within the cap", () => {
		const from = "2026-05-01T00:00:00.000Z";
		const to = "2026-06-01T00:00:00.000Z";
		const w = resolveAnalyticsWindow(from, to);
		expect(w.from).toBe(from);
		expect(w.to).toBe(to);
	});

	test("defaults to to now when only from is supplied", () => {
		const before = Date.now();
		const from = "2026-07-01T00:00:00.000Z";
		const w = resolveAnalyticsWindow(from, undefined);
		expect(w.from).toBe(from);
		expect(Date.parse(w.to)).toBeGreaterThanOrEqual(before);
	});

	test("clamps a span beyond 90 days by pulling from forward (warren-30cc)", () => {
		const from = "2020-01-01T00:00:00.000Z";
		const to = "2030-01-01T00:00:00.000Z";
		const w = resolveAnalyticsWindow(from, to);
		expect(w.to).toBe(to);
		expect(Date.parse(w.to) - Date.parse(w.from)).toBe(ANALYTICS_MAX_WINDOW_DAYS * DAY_MS);
	});

	test("clamps an absent-to span beyond 90 days as well", () => {
		const from = "2000-01-01T00:00:00.000Z";
		const w = resolveAnalyticsWindow(from, undefined);
		expect(Date.parse(w.to) - Date.parse(w.from)).toBe(ANALYTICS_MAX_WINDOW_DAYS * DAY_MS);
	});
});

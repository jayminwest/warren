import { describe, expect, test } from "bun:test";
import { dayKey, SpendLedger } from "./spend-ledger.ts";

describe("dayKey", () => {
	test("buckets by the UTC calendar day", () => {
		expect(dayKey(new Date("2026-08-15T23:59:59.000Z"))).toBe("2026-08-15");
		expect(dayKey(new Date("2026-08-16T00:00:00.000Z"))).toBe("2026-08-16");
	});
});

describe("SpendLedger", () => {
	test("sums spend per UTC day across records", () => {
		const ledger = new SpendLedger(":memory:");
		ledger.record(0.01, new Date("2026-08-15T10:00:00.000Z"));
		ledger.record(0.02, new Date("2026-08-15T22:00:00.000Z"));
		ledger.record(0.5, new Date("2026-08-16T01:00:00.000Z"));
		expect(ledger.spendForDay("2026-08-15")).toBeCloseTo(0.03, 10);
		expect(ledger.spendForDay("2026-08-16")).toBeCloseTo(0.5, 10);
		ledger.close();
	});

	test("reports zero for a day with no records", () => {
		const ledger = new SpendLedger(":memory:");
		expect(ledger.spendForDay("2026-08-15")).toBe(0);
		ledger.close();
	});

	test("rejects a negative or non-finite cost", () => {
		const ledger = new SpendLedger(":memory:");
		expect(() => ledger.record(-1, new Date())).toThrow(/non-negative/);
		expect(() => ledger.record(Number.NaN, new Date())).toThrow(/non-negative/);
		ledger.close();
	});
});

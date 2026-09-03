import { describe, expect, test } from "bun:test";
import { formatCostUsd } from "./run-detail-format.ts";

describe("formatCostUsd", () => {
	test("formats sub-dollar costs with three decimals", () => {
		expect(formatCostUsd(0.005)).toBe("$0.005");
	});

	test("formats zero as $0.00", () => {
		expect(formatCostUsd(0)).toBe("$0.00");
	});

	test("formats dollar-and-up costs with two decimals", () => {
		expect(formatCostUsd(1.234)).toBe("$1.23");
	});

	test("warren-17d7: returns the em-dash for null and undefined", () => {
		// The spectator projection strips maxCostUsd
		// (REDACTED_PLAN_RUN_FIELDS), so callers see undefined — that used
		// to throw `toFixed of undefined`.
		expect(formatCostUsd(null)).toBe("—");
		expect(formatCostUsd(undefined)).toBe("—");
	});
});

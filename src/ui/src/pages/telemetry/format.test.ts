import { describe, expect, test } from "bun:test";
// Relative import, not the `@/` alias — this file runs under the repo-root
// `bun test`, which resolves no `@/` (see labels.test.ts).
import { formatDuration, formatScore } from "./format.ts";

describe("formatScore", () => {
	test("truncates full float precision to two decimals", () => {
		expect(formatScore(0.8333333333333334)).toBe("0.83");
	});

	test("pads short scores to two decimals", () => {
		expect(formatScore(1)).toBe("1.00");
		expect(formatScore(0)).toBe("0.00");
	});
});

describe("formatDuration", () => {
	test("renders null as an em dash", () => {
		expect(formatDuration(null)).toBe("—");
	});

	test("renders seconds under 90s", () => {
		expect(formatDuration(54_000)).toBe("54s");
	});

	test("renders minutes with zero-padded seconds", () => {
		expect(formatDuration(11 * 60_000 + 24_000)).toBe("11m 24s");
	});

	test("renders whole minutes without seconds", () => {
		expect(formatDuration(5 * 60_000)).toBe("5m");
	});

	test("renders hours with one decimal past 90 minutes", () => {
		expect(formatDuration(16.8 * 3_600_000)).toBe("16.8h");
	});
});

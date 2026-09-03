import { describe, expect, test } from "bun:test";
import type { RunEvent, RunRow } from "@/api/types.ts";
import {
	extractReapSummary,
	findFirstText,
	findToolUseName,
	formatCostUsd,
	formatTokenBreakdown,
	formatTokens,
	formatWallClock,
	isBridgeStalled,
	readCostTotal,
	readNumber,
	readString,
	truncateSummary,
} from "./run-detail-format.ts";

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

describe("formatTokens", () => {
	test("formats small, thousands, and millions", () => {
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(2_500_000)).toBe("2.5M");
	});
});

describe("formatTokenBreakdown", () => {
	test("joins present counters and drops absent / zero ones", () => {
		expect(
			formatTokenBreakdown({
				tokensInput: 1000,
				tokensOutput: 2000,
				tokensCacheRead: 0,
				tokensCacheWrite: null,
			} as unknown as RunRow),
		).toBe("1.0k in · 2.0k out");
		expect(
			formatTokenBreakdown({
				tokensInput: null,
				tokensOutput: null,
				tokensCacheRead: null,
				tokensCacheWrite: null,
			} as unknown as RunRow),
		).toBe(null);
	});
});

describe("formatWallClock", () => {
	test("extracts HH:MM:SS from ISO, else returns the raw string", () => {
		expect(formatWallClock("2026-09-03T10:05:30.123Z")).toBe("10:05:30");
		expect(formatWallClock("not-a-timestamp")).toBe("not-a-timestamp");
	});
});

describe("truncateSummary", () => {
	test("passes short strings through and ellipsizes long ones", () => {
		expect(truncateSummary("short")).toBe("short");
		const long = "x".repeat(200);
		expect(truncateSummary(long)).toBe(`${"x".repeat(139)}…`);
	});
});

describe("readString / readNumber", () => {
	test("narrow to the declared type, else null", () => {
		expect(readString("a")).toBe("a");
		expect(readString(5)).toBe(null);
		expect(readNumber(5)).toBe(5);
		expect(readNumber("5")).toBe(null);
	});
});

describe("readCostTotal", () => {
	test("reads a numeric total off an object payload", () => {
		expect(readCostTotal({ total: 1.5 })).toBe(1.5);
		expect(readCostTotal({ total: "1.5" })).toBe(null);
		expect(readCostTotal(2)).toBe(2);
		expect(readCostTotal(null)).toBe(null);
		expect(readCostTotal([1])).toBe(null);
	});
});

describe("extractReapSummary", () => {
	test("returns the latest reap.completed payload", () => {
		const events = [
			{ kind: "state_change", payload: null },
			{ kind: "reap.completed", payload: { branchPushed: true } },
			{ kind: "state_change", payload: null },
		] as unknown as RunEvent[];
		expect(extractReapSummary(events)).toEqual({ branchPushed: true });
	});

	test("returns null for a malformed payload or no reap event", () => {
		expect(
			extractReapSummary([{ kind: "reap.completed", payload: "junk" } as unknown as RunEvent[]]),
		).toBe(null);
		expect(
			extractReapSummary([{ kind: "state_change", payload: null } as unknown as RunEvent[]]),
		).toBe(null);
	});
});

describe("isBridgeStalled", () => {
	test("true on a stall not yet recovered, false otherwise", () => {
		expect(isBridgeStalled([{ kind: "bridge_stalled" } as unknown as RunEvent])).toBe(true);
		expect(
			isBridgeStalled([
				{ kind: "bridge_stalled" } as unknown as RunEvent,
				{ kind: "bridge_recovered" } as unknown as RunEvent,
			]),
		).toBe(false);
		expect(isBridgeStalled([])).toBe(false);
	});
});

describe("findToolUseName / findFirstText", () => {
	test("find the first tool_use name in a content array", () => {
		expect(findToolUseName([{ type: "tool_use", name: "bash" }])).toBe("bash");
		expect(findToolUseName([{ type: "text" }])).toBe(null);
		expect(findToolUseName("junk")).toBe(null);
	});

	test("find the first text across string and array content", () => {
		expect(findFirstText("plain")).toBe("plain");
		expect(findFirstText([{ type: "text", text: "hello" }, "alt"])).toBe("hello");
		expect(findFirstText([{ type: "text" }])).toBe(null);
		expect(findFirstText(null)).toBe(null);
	});
});

import { describe, expect, test } from "bun:test";
import type { RunRow } from "@/api/types.ts";
import {
	activeWorkloads,
	activityLine,
	formatDurationMs,
	LIFECYCLE_ORDER,
	oldestPhaseInstant,
	phaseElapsedMs,
	phaseInstant,
	refreshedAgeLabel,
	shortRepo,
} from "./operations.helpers.ts";

/** Minimal run-shaped fixture — only phase fields feed the helpers. */
function run(overrides: Partial<RunRow>): RunRow {
	return {
		id: "run_test",
		agentName: "pi",
		projectId: "p1",
		seedId: null,
		parentRunId: null,
		cloneKind: null,
		retryOf: null,
		mode: "batch",
		renderedAgentJson: null,
		state: "running",
		failureReason: null,
		createdAt: null,
		startedAt: null,
		endedAt: null,
		commitsAhead: null,
		filesChanged: null,
		insertions: null,
		deletions: null,
		prompt: "do the thing",
		trigger: "manual",
		prUrl: null,
		prState: null,
		prMergedAt: null,
		targetBranch: null,
		ref: null,
		baseCommit: null,
		provider: null,
		model: null,
		salvageRef: null,
		salvagePath: null,
		costUsd: null,
		tokensInput: null,
		tokensOutput: null,
		...overrides,
	} as RunRow;
}

describe("formatDurationMs", () => {
	test("renders mm:ss under an hour", () => {
		expect(formatDurationMs(38_000)).toBe("00:38");
		expect(formatDurationMs(31 * 60_000 + 42_000)).toBe("31:42");
	});
	test("renders hh:mm:ss at an hour and above", () => {
		expect(formatDurationMs(3 * 3_600_000 + 14 * 60_000 + 9_000)).toBe("3:14:09");
	});
	test("unknown instants render an em dash, never zero", () => {
		expect(formatDurationMs(null)).toBe("—");
		expect(formatDurationMs(undefined)).toBe("—");
		expect(formatDurationMs(Number.NaN)).toBe("—");
	});
});

describe("phaseInstant", () => {
	test("uses createdAt while queued and startedAt after admission", () => {
		const queued = run({ state: "queued", createdAt: 1_000, startedAt: 2_000 });
		expect(phaseInstant(queued)).toBe(1_000);
		const started = run({ state: "running", createdAt: 1_000, startedAt: "1970-01-01T00:00:03Z" });
		expect(phaseInstant(started)).toBe(3_000);
	});
	test("null instants stay unknown", () => {
		expect(phaseInstant(run({ state: "running", createdAt: 1_000, startedAt: null }))).toBeNull();
		expect(phaseInstant(run({ state: "queued", createdAt: null }))).toBeNull();
	});
});

describe("phaseElapsedMs", () => {
	test("measures now minus the phase instant", () => {
		const r = run({ state: "queued", createdAt: 1_000 });
		expect(phaseElapsedMs(r, 41_000)).toBe(40_000);
	});
	test("unknown instant yields null", () => {
		expect(phaseElapsedMs(run({ state: "queued", createdAt: null }), 41_000)).toBeNull();
	});
});

describe("oldestPhaseInstant", () => {
	test("finds the oldest run in the given state, ignoring others", () => {
		const runs = [
			run({ state: "queued", createdAt: 3_000 }),
			run({ state: "queued", createdAt: 1_000 }),
			run({ state: "running", startedAt: "1970-01-01T00:00:00.500Z" }),
			run({ state: "queued", createdAt: null }),
		];
		expect(oldestPhaseInstant(runs, "queued")).toBe(1_000);
		expect(oldestPhaseInstant(runs, "succeeded")).toBeNull();
	});
});

describe("activeWorkloads", () => {
	test("returns non-terminal runs oldest-phase-first, bounded by limit", () => {
		const runs = [
			run({ id: "a", state: "succeeded", createdAt: 0 }),
			run({ id: "b", state: "queued", createdAt: 3_000 }),
			run({ id: "c", state: "running", createdAt: 1_000, startedAt: "1970-01-01T00:00:01Z" }),
			run({ id: "d", state: "queued", createdAt: 2_000 }),
		];
		expect(activeWorkloads(runs, 2).map((r) => r.id)).toEqual(["c", "d"]);
	});
});

describe("LIFECYCLE_ORDER", () => {
	test("follows the canvas phase order", () => {
		expect(LIFECYCLE_ORDER).toEqual(["queued", "running", "succeeded", "failed", "cancelled"]);
	});
});

describe("shortRepo", () => {
	test("derives owner/name from https and ssh URLs", () => {
		expect(shortRepo("https://github.com/os-eco/warren.git")).toBe("os-eco/warren");
		expect(shortRepo("git@github.com:os-eco/mulch.git")).toBe("os-eco/mulch");
		expect(shortRepo("/local/path")).toBe("local/path");
	});
	test("passes through single-segment shapes", () => {
		expect(shortRepo("just-a-name")).toBe("just-a-name");
	});
});

describe("activityLine", () => {
	test("takes the first prompt line and clips long ones", () => {
		expect(activityLine("first line\nsecond line")).toBe("first line");
		const long = `${"x".repeat(100)}`;
		expect(activityLine(long)).toHaveLength(80);
		expect(activityLine(long).endsWith("…")).toBe(true);
	});
});

describe("refreshedAgeLabel", () => {
	test("renders seconds under a minute", () => {
		expect(refreshedAgeLabel(2_000)).toBe("2S AGO");
		expect(refreshedAgeLabel(59_999)).toBe("59S AGO");
	});
	test("rolls to minutes and hours", () => {
		expect(refreshedAgeLabel(240_000)).toBe("4M AGO");
		expect(refreshedAgeLabel(3 * 3_600_000)).toBe("3H AGO");
	});
	test("treats null, negative, and non-finite ages as just-now", () => {
		expect(refreshedAgeLabel(null)).toBe("JUST NOW");
		expect(refreshedAgeLabel(undefined)).toBe("JUST NOW");
		expect(refreshedAgeLabel(-5_000)).toBe("JUST NOW");
		expect(refreshedAgeLabel(Number.NaN)).toBe("JUST NOW");
	});
});

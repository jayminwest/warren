import { describe, expect, test } from "bun:test";
import type { RunRow } from "@/api/types.ts";
import { formatCostUsd } from "../run-detail-format.ts";
import {
	branchLabelOf,
	formatDuration,
	formatElapsedMs,
	projectLabel,
	runCostLabel,
	runtimeTitleOf,
	shortSha,
	startedAtOf,
} from "./runs-format.ts";

/** Minimal run-shaped fixture — only the fields branchLabelOf reads. */
function run(overrides: Partial<RunRow>): RunRow {
	return {
		id: "run_abc123",
		agentName: "claude-code",
		projectId: "p1",
		seedId: null,
		parentRunId: null,
		cloneKind: null,
		retryOf: null,
		mode: "batch",
		renderedAgentJson: null,
		state: "running",
		failureReason: null,
		createdAt: 0,
		startedAt: null,
		endedAt: null,
		commitsAhead: null,
		filesChanged: null,
		insertions: null,
		deletions: null,
		prompt: "",
		trigger: "manual",
		prUrl: null,
		prState: null,
		prMergedAt: null,
		targetBranch: null,
		branch: null,
		ref: null,
		baseCommit: null,
		baseSha: null,
		provider: null,
		model: null,
		salvageRef: null,
		salvagePath: null,
		costUsd: null,
		costBasis: "metered",
		tokensInput: null,
		tokensOutput: null,
		tokensCacheRead: null,
		tokensCacheWrite: null,
		previewState: null,
		previewPort: null,
		previewStartedAt: null,
		previewLastHitAt: null,
		...overrides,
	};
}

describe("branchLabelOf", () => {
	test("prefers the explicit dispatch targetBranch", () => {
		expect(branchLabelOf(run({ targetBranch: "feat/x", branch: "run_abc", ref: "main" }))).toBe(
			"feat/x",
		);
	});

	test("falls back to the composed workspace branch set at dispatch", () => {
		expect(branchLabelOf(run({ branch: "warren/run_abc123", ref: "main" }))).toBe(
			"warren/run_abc123",
		);
	});

	test("falls back to the raw clone ref last", () => {
		expect(branchLabelOf(run({ ref: "main" }))).toBe("main");
	});

	test("returns null when the row predates the columns", () => {
		expect(branchLabelOf(run({}))).toBeNull();
	});
});

describe("runtimeTitleOf (warren-9474)", () => {
	test("joins the backend kind and the full runtime handle", () => {
		expect(
			runtimeTitleOf(run({ runtimeBackend: "k8s", sandboxRunId: "warren-run-abcdef123456" })),
		).toBe("Runtime: k8s · warren-run-abcdef123456");
	});

	test("falls back to the sandbox id, then to the kind alone", () => {
		expect(runtimeTitleOf(run({ runtimeBackend: null, sandboxId: "sbx-1" }))).toBe(
			"Runtime: sbx-1",
		);
		expect(runtimeTitleOf(run({ runtimeBackend: "local" }))).toBe("Runtime: local");
	});

	test("is undefined when the row carries neither fact (a spectator's view)", () => {
		expect(runtimeTitleOf(run({}))).toBeUndefined();
	});
});

describe("formatDuration", () => {
	test("reads a finished run from start to end", () => {
		const row = run({ startedAt: "2026-09-25T10:00:00Z", endedAt: "2026-09-25T10:14:12Z" });
		expect(formatDuration(row, 0)).toBe("14:12");
	});

	test("ticks a live run against now and falls back to createdAt", () => {
		const created = Date.parse("2026-09-25T10:00:00Z");
		const row = run({ createdAt: created });
		expect(startedAtOf(row)).toBe("2026-09-25T10:00:00.000Z");
		expect(formatDuration(row, created + 2 * 3600_000 + 31 * 60_000 + 42_000)).toBe("2:31:42");
	});

	test("renders a dash for an unstarted or clock-skewed run", () => {
		expect(formatDuration(run({ createdAt: null }), 0)).toBe("—");
		expect(formatDuration(run({ startedAt: "nope" }), 0)).toBe("—");
		const row = run({ startedAt: "2026-09-25T10:00:00Z", endedAt: "2026-09-25T09:00:00Z" });
		expect(formatDuration(row, 0)).toBe("—");
	});
});

describe("formatElapsedMs", () => {
	test("switches to a day prefix past 24 hours", () => {
		expect(formatElapsedMs(3 * 86_400_000 + 4 * 3600_000 + 10 * 60_000)).toBe("3d 04:10");
	});
});

describe("projectLabel", () => {
	test("strips the GitHub host and falls back when absent", () => {
		expect(projectLabel("https://github.com/os-eco/warren", "p1")).toBe("os-eco/warren");
		expect(projectLabel("https://github.com/", "p1")).toBe("https://github.com/");
		expect(projectLabel(null, "p1")).toBe("p1");
	});
});

describe("shortSha", () => {
	test("keeps seven characters and blanks a missing sha", () => {
		expect(shortSha("0123456789abcdef")).toBe("0123456");
		expect(shortSha(null)).toBe("");
		expect(shortSha("")).toBe("");
	});
});

describe("runCostLabel", () => {
	test("dashes an unmeasured run and marks subscription estimates", () => {
		expect(runCostLabel(run({ costUsd: null }))).toBe("—");
		expect(runCostLabel(run({ costUsd: 0.412 }))).toBe(formatCostUsd(0.412));
		expect(runCostLabel(run({ costUsd: 0.412, costBasis: "subscription_estimate" }))).toBe(
			`~${formatCostUsd(0.412)} est.`,
		);
	});
});

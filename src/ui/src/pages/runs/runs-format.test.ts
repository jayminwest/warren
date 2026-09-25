import { describe, expect, test } from "bun:test";
import type { RunRow } from "@/api/types.ts";
import { branchLabelOf, runtimeTitleOf } from "./runs-format.ts";

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

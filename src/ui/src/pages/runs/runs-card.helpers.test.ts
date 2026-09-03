import { describe, expect, test } from "bun:test";
import type { RunRow } from "@/api/types.ts";
import { capPctOf, costNoteToneOf, stateCellOf, sublineOf } from "./runs-card.helpers.ts";

/** Minimal run-shaped fixture — only the fields the card helpers read. */
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

describe("stateCellOf", () => {
	test("routes cancelled to the neutral tone with the short word", () => {
		expect(stateCellOf(run({ state: "cancelled" }))).toEqual({ tone: "neutral", label: "cancel" });
	});

	test("picks merged / PR open from a succeeded run's PR facts", () => {
		expect(stateCellOf(run({ state: "succeeded", prMergedAt: "2026-08-01" }))).toEqual({
			tone: "success",
			label: "merged",
		});
		expect(stateCellOf(run({ state: "succeeded", prState: "open" }))).toEqual({
			tone: "info",
			label: "PR open",
		});
		expect(stateCellOf(run({ state: "succeeded" }))).toEqual({
			tone: "success",
			label: "succeeded",
		});
	});
});

describe("sublineOf", () => {
	test("trims to agent · project with no extra for a plain running row", () => {
		expect(sublineOf(run({}), "os-eco/warren")).toBe("claude-code · os-eco/warren");
	});

	test("keeps the old chain/branch segments out of the mobile subline", () => {
		const row = run({
			parentRunId: "run_parent",
			targetBranch: "main",
			baseCommit: "abc1234ef",
			baseSha: null,
		});
		expect(sublineOf(row, "os-eco/warren")).toBe("claude-code · os-eco/warren");
	});

	test("failed rows carry one short stop-reason extra", () => {
		expect(
			sublineOf(run({ state: "failed", failureReason: "push_rejected_policy" }), "os-eco/warren"),
		).toBe("claude-code · os-eco/warren · push blocked");
	});

	test("delivered rows carry the PR ref when one exists, else the commit count", () => {
		expect(
			sublineOf(
				run({ state: "succeeded", prUrl: "https://github.com/x/y/pull/984" }),
				"os-eco/warren",
			),
		).toBe("claude-code · os-eco/warren · PR #984");
		expect(sublineOf(run({ state: "succeeded", commitsAhead: 2 }), "os-eco/warren")).toBe(
			"claude-code · os-eco/warren · 2 commits",
		);
	});

	test("running rows near cap carry the cap percent, not branch noise", () => {
		const row = run({ costUsd: 4.72, maxCostUsd: 5, targetBranch: "main" });
		expect(sublineOf(row, "os-eco/mulch")).toBe("claude-code · os-eco/mulch · cap 94%");
	});
});

describe("capPctOf / costNoteToneOf", () => {
	test("returns null below the subline threshold and no cap at all", () => {
		expect(capPctOf(run({ costUsd: 0.4, maxCostUsd: 5 }))).toBeNull();
		expect(capPctOf(run({ costUsd: 0.4 }))).toBeNull();
		expect(capPctOf(run({ costUsd: 0.4, maxCostUsd: null }))).toBeNull();
	});

	test("warns on the cost note only at the near-cap threshold", () => {
		expect(costNoteToneOf(run({ costUsd: 4.0, maxCostUsd: 5 }))).toBe("default");
		expect(costNoteToneOf(run({ costUsd: 4.5, maxCostUsd: 5 }))).toBe("warning");
		expect(costNoteToneOf(run({ costUsd: 4.5 }))).toBe("default");
	});
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { RunRow } from "@/api/types.ts";
import { RunsTable } from "./runs-table.tsx";

/** Minimal run-shaped fixture — only the fields the table reads. */
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
		branch: "warren/run_abc123",
		ref: null,
		baseCommit: null,
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

function renderTable(rows: RunRow[], isOperator: boolean): string {
	return renderToStaticMarkup(
		<MemoryRouter>
			<RunsTable
				rows={rows}
				projectIndex={new Map([["p1", "os-eco/warren"]])}
				now={1000}
				isOperator={isOperator}
			/>
		</MemoryRouter>,
	);
}

describe("RunsTable Runtime column", () => {
	test("renders the Runtime column for an operator", () => {
		const html = renderTable([run({ sandboxRunId: "pod-xyz", sandboxId: "sbx-1" })], true);
		expect(html).toContain(">Runtime<");
		expect(html).toContain("pod-xyz");
	});

	test("hides the Runtime column for a spectator even when handles exist", () => {
		const html = renderTable([run({ sandboxRunId: "pod-xyz", sandboxId: "sbx-1" })], false);
		expect(html).not.toContain(">Runtime<");
		expect(html).not.toContain("pod-xyz");
	});
});

describe("RunsTable Project branch sub-line", () => {
	test("shows the composed workspace branch when no targetBranch/ref is set", () => {
		const html = renderTable([run({ branch: "warren/run_abc123" })], true);
		expect(html).toContain("warren/run_abc123");
		expect(html).toContain('title="warren/run_abc123"');
	});
});

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

describe("RunsTable row", () => {
	test("puts the runtime facts on the run id tooltip for an operator", () => {
		const html = renderTable(
			[run({ runtimeBackend: "k8s", sandboxRunId: "warren-run-abcdef123456" })],
			true,
		);
		expect(html).toContain('title="Runtime: k8s · warren-run-abcdef123456"');
		// No column is spent on the handle any more (warren-9474).
		expect(html).not.toContain(">Runtime<");
	});

	test("never renders runtime facts for a spectator", () => {
		const html = renderTable([run({ sandboxRunId: "pod-xyz", sandboxId: "sbx-1" })], false);
		expect(html).not.toContain("pod-xyz");
	});

	test("reads a failed run's reason instead of the bare state", () => {
		const html = renderTable([run({ state: "failed", failureReason: "timeout" })], true);
		expect(html).not.toContain(">Failed<");
	});

	test("renders the PR as a chip with its lifecycle", () => {
		const html = renderTable(
			[
				run({
					state: "succeeded",
					prUrl: "https://github.com/x/y/pull/42",
					prState: "merged",
				}),
			],
			true,
		);
		expect(html).toContain("#42");
		expect(html).toContain("Merged");
	});

	test("shows the tracker item under the run id", () => {
		const html = renderTable([run({ seedId: "warren-30e7" })], true);
		expect(html).toContain(">warren-30e7<");
	});
});

describe("RunsTable Project branch tooltip", () => {
	test("puts the composed workspace branch on the project tooltip", () => {
		const html = renderTable([run({ branch: "warren/run_abc123" })], true);
		expect(html).toContain('title="warren/run_abc123"');
	});
});

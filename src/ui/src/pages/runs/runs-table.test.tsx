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

	test("renders backend kind plus a truncated copyable handle (warren-a0f4)", () => {
		const html = renderTable(
			[
				run({
					runtimeBackend: "k8s",
					sandboxRunId: "warren-run-abcdef123456",
					sandboxId: "sbx-1",
				}),
			],
			true,
		);
		expect(html).toContain(">k8s<");
		// truncated to ~10 chars with the full handle on hover
		expect(html).toContain("warren-run");
		expect(html).not.toContain("warren-run-abcdef123456>");
		expect(html).toContain('title="warren-run-abcdef123456"');
		expect(html).toContain('aria-label="Copy runtime handle warren-run-abcdef123456"');
	});

	test("renders a short handle untruncated", () => {
		const html = renderTable(
			[run({ runtimeBackend: "docker", sandboxRunId: "run_1", sandboxId: null })],
			true,
		);
		expect(html).toContain(">docker<");
		expect(html).toContain(">run_1<");
	});

	test("renders the kind alone when no handle was assigned yet", () => {
		const html = renderTable([run({ runtimeBackend: "local", sandboxRunId: null })], true);
		expect(html).toContain(">local<");
		expect(html).not.toContain("aria-label");
	});

	test("falls back to the handle on line one when no backend kind is recorded", () => {
		const html = renderTable(
			[run({ runtimeBackend: null, sandboxRunId: "pod-legacy", sandboxId: null })],
			true,
		);
		expect(html).toContain("pod-legacy");
		expect(html).not.toContain("aria-label");
	});
});

describe("RunsTable Project branch sub-line", () => {
	test("shows the composed workspace branch when no targetBranch/ref is set", () => {
		const html = renderTable([run({ branch: "warren/run_abc123" })], true);
		expect(html).toContain("warren/run_abc123");
		expect(html).toContain('title="warren/run_abc123"');
	});
});

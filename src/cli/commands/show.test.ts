import { describe, expect, test } from "bun:test";
import type { RunRow, WarrenClient } from "../../client/index.ts";
import type { CliContext, OutputMode } from "../output.ts";
import { runShow } from "./show.ts";

function captureContext(output?: OutputMode): {
	context: CliContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: {},
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		...(output !== undefined ? { output } : {}),
	};
	return { context, out, err };
}

function runRow(over: Partial<RunRow> = {}): RunRow {
	return {
		id: "run-1",
		agentName: "claude-code",
		projectId: "prj_1",
		sandboxId: "bur-1",
		sandboxRunId: "brun-1",
		seedId: null,
		parentRunId: null,
		retryOf: null,
		cloneKind: null,
		mode: "batch",
		costBasis: "api",
		renderedAgentJson: {},
		state: "succeeded",
		failureReason: null,
		createdAt: null,
		commitsAhead: null,
		filesChanged: null,
		insertions: null,
		deletions: null,
		startedAt: "2026-08-04T00:00:00.000Z",
		workspaceReadyAt: null,
		agentReadyAt: null,
		agentEndedAt: null,
		reapedAt: null,
		endedAt: "2026-08-04T00:01:00.000Z",
		prompt: "do the thing",
		trigger: "cli",
		prUrl: "https://github.com/os-eco/warren/pull/42",
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
		costUsd: 0.01,
		tokensInput: 10,
		tokensOutput: 20,
		tokensCacheRead: null,
		tokensCacheWrite: null,
		previewState: null,
		previewPort: null,
		previewStartedAt: null,
		previewLastHitAt: null,
		previewFailureMessage: null,
		...over,
	};
}

function client(over: { probe?: () => Promise<void>; getRun?: () => Promise<RunRow> } = {}) {
	return {
		probe: over.probe ?? (async () => undefined),
		getRun: over.getRun ?? (async () => runRow()),
	} as unknown as WarrenClient;
}

describe("runShow", () => {
	test("rejects-empty-run-id-with-exit-2", async () => {
		const { context, err } = captureContext();
		const res = await runShow(context, { client: client() }, { runId: "" });
		expect(res.exitCode).toBe(2);
		expect(err.join("")).toContain("required");
	});

	test("reports-unreachable-warren-with-exit-3", async () => {
		const { context, err } = captureContext();
		const res = await runShow(
			context,
			{
				client: client({
					probe: async () => {
						throw new Error("warren unreachable at http://w.local");
					},
				}),
			},
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(3);
		expect(err.join("")).toContain("unreachable");
	});

	test("ndjson-emits-the-raw-run-document-as-one-line", async () => {
		const { context, out } = captureContext();
		const res = await runShow(context, { client: client() }, { runId: "run-1" });
		expect(res.exitCode).toBe(0);
		expect(res.state).toBe("succeeded");
		const lines = out.join("").trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as RunRow;
		expect(parsed.id).toBe("run-1");
		expect(parsed.agentName).toBe("claude-code");
	});

	test("json-emits-the-indented-run-document", async () => {
		const { context, out } = captureContext("json");
		const res = await runShow(context, { client: client() }, { runId: "run-1" });
		expect(res.exitCode).toBe(0);
		const text = out.join("");
		expect(text).toContain("\n  ");
		expect(JSON.parse(text)).toMatchObject({ id: "run-1", state: "succeeded" });
	});

	test("pretty-renders-glyph-summary-with-d6-duration", async () => {
		const { context, out } = captureContext("pretty");
		const res = await runShow(context, { client: client() }, { runId: "run-1" });
		expect(res.exitCode).toBe(0);
		const text = out.join("");
		expect(text).toContain("✔ run run-1 [succeeded]");
		expect(text).toContain("1.0m");
		expect(text).toContain("$0.0100");
		expect(text).toContain("https://github.com/os-eco/warren/pull/42");
	});

	test("summary-emits-the-compact-projection-as-one-line", async () => {
		const { context, out } = captureContext();
		const res = await runShow(context, { client: client() }, { runId: "run-1", summary: true });
		expect(res.exitCode).toBe(0);
		const lines = out.join("").trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
		expect(parsed).toEqual({
			id: "run-1",
			state: "succeeded",
			failureReason: null,
			prUrl: "https://github.com/os-eco/warren/pull/42",
			costUsd: 0.01,
			endedAt: "2026-08-04T00:01:00.000Z",
		});
	});

	test("summary-in-json-mode-emits-the-indented-projection", async () => {
		const { context, out } = captureContext("json");
		const res = await runShow(context, { client: client() }, { runId: "run-1", summary: true });
		expect(res.exitCode).toBe(0);
		const text = out.join("");
		expect(text).toContain("\n  ");
		const parsed = JSON.parse(text) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual([
			"costUsd",
			"endedAt",
			"failureReason",
			"id",
			"prUrl",
			"state",
		]);
	});

	test("maps-a-getRun-failure-to-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runShow(
			context,
			{
				client: client({
					getRun: async () => {
						throw new Error("boom");
					},
				}),
			},
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(1);
		expect(err.join("")).toContain("boom");
	});
});

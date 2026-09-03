import { describe, expect, test } from "bun:test";
import {
	type RunRow,
	type WaitForRunOptions,
	type WarrenClient,
	WarrenClientError,
} from "../../client/index.ts";
import type { CliContext, OutputMode } from "../output.ts";
import { runWait } from "./wait.ts";

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
		endedAt: "2026-08-04T00:00:04.200Z",
		prompt: "do the thing",
		trigger: "cli",
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
		costUsd: 0.01,
		tokensInput: null,
		tokensOutput: null,
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

interface ClientOverrides {
	probe?: () => Promise<void>;
	waitForRun?: (runId: string, opts: WaitForRunOptions) => Promise<RunRow>;
}

function client(over: ClientOverrides = {}) {
	return {
		probe: over.probe ?? (async () => undefined),
		waitForRun: over.waitForRun ?? (async () => runRow()),
	} as unknown as WarrenClient;
}

describe("runWait", () => {
	test("rejects-empty-run-id-with-exit-2", async () => {
		const { context, err } = captureContext();
		const res = await runWait(context, { client: client() }, { runId: "" });
		expect(res.exitCode).toBe(2);
		expect(err.join("")).toContain("required");
	});

	test("reports-unreachable-warren-with-exit-3", async () => {
		const { context } = captureContext();
		const res = await runWait(
			context,
			{
				client: client({
					probe: async () => {
						throw new Error("warren unreachable");
					},
				}),
			},
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(3);
	});

	test("exits-0-on-succeeded-and-emits-the-terminal-document", async () => {
		const { context, out } = captureContext();
		const res = await runWait(context, { client: client() }, { runId: "run-1" });
		expect(res.exitCode).toBe(0);
		expect(res.state).toBe("succeeded");
		const parsed = JSON.parse(out.join("")) as RunRow;
		expect(parsed.state).toBe("succeeded");
	});

	test("exits-1-on-failed-terminal-state", async () => {
		const { context } = captureContext();
		const res = await runWait(
			context,
			{
				client: client({
					waitForRun: async () => runRow({ state: "failed", failureReason: "crashed" }),
				}),
			},
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(1);
		expect(res.state).toBe("failed");
	});

	test("exits-1-on-cancelled-terminal-state", async () => {
		const { context } = captureContext();
		const res = await runWait(
			context,
			{ client: client({ waitForRun: async () => runRow({ state: "cancelled" }) }) },
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(1);
	});

	test("forwards-the-timeout-budget-to-the-sdk", async () => {
		const { context } = captureContext();
		let seen: WaitForRunOptions | undefined;
		await runWait(
			context,
			{
				client: client({
					waitForRun: async (_id, opts) => {
						seen = opts;
						return runRow();
					},
				}),
			},
			{ runId: "run-1", timeoutMs: 5_000 },
		);
		expect(seen?.timeoutMs).toBe(5_000);
	});

	test("maps-a-wait-timeout-to-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runWait(
			context,
			{
				client: client({
					waitForRun: async () => {
						throw new WarrenClientError(408, "wait_timeout", "run run-1 did not terminate");
					},
				}),
			},
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(1);
		expect(err.join("")).toContain("wait_timeout");
	});

	test("summary-emits-the-compact-projection-as-one-line", async () => {
		const { context, out } = captureContext();
		const res = await runWait(context, { client: client() }, { runId: "run-1", summary: true });
		expect(res.exitCode).toBe(0);
		const lines = out.join("").trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
		expect(parsed).toEqual({
			id: "run-1",
			state: "succeeded",
			failureReason: null,
			prUrl: null,
			costUsd: 0.01,
			endedAt: "2026-08-04T00:00:04.200Z",
		});
	});

	test("pretty-renders-the-glyph-summary", async () => {
		const { context, out } = captureContext("pretty");
		const res = await runWait(context, { client: client() }, { runId: "run-1" });
		expect(res.exitCode).toBe(0);
		const text = out.join("");
		expect(text).toContain("✔ run run-1 [succeeded]");
		expect(text).toContain("4.2s");
	});
});

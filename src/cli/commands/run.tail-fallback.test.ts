/**
 * gh #1305 (warren-ee79): once `run.spawned` is printed, a failed event tail
 * (503 `event_stream_capacity`, ECONNRESET) must not report the live run as
 * failed. The CLI names the run and the tail error, then polls for the real
 * terminal state.
 */
import { describe, expect, test } from "bun:test";
import {
	type RunEvent,
	type RunRow,
	type WaitForRunOptions,
	type WarrenClient,
	WarrenClientError,
	WarrenUnreachableError,
} from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { runRun, TAIL_FAILED_TERMINAL_TIMEOUT_MS } from "./run.ts";

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: {},
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
	return { context, out, err };
}

function row(state: RunRow["state"]): RunRow {
	return {
		id: "run-1",
		agentName: "claude-code",
		projectId: "prj_1",
		state,
		failureReason: null,
		prUrl: null,
	} as unknown as RunRow;
}

interface MockInput {
	readonly streamError: Error;
	/** Outcome of waitForRun: a row, or an error to throw. */
	readonly wait: RunRow | Error;
	readonly waitCalls: WaitForRunOptions[];
}

function mockClient(input: MockInput): WarrenClient {
	return {
		probe: async () => undefined,
		createRun: async () => ({
			run: row("running"),
			sandbox: { id: "bur-1", workspacePath: "/ws/run-1" },
		}),
		streamRunEvents: () =>
			(async function* (): AsyncGenerator<RunEvent, void, void> {
				yield* [];
				throw input.streamError;
			})(),
		getRun: async () => row("running"),
		waitForRun: async (_id: string, opts: WaitForRunOptions = {}) => {
			input.waitCalls.push(opts);
			if (input.wait instanceof Error) throw input.wait;
			return input.wait;
		},
	} as unknown as WarrenClient;
}

function parseLines(chunks: string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const ARGS = { agent: "claude-code", project: "prj_1", prompt: "do the thing" };

describe("runRun tail-failure fallback (gh #1305)", () => {
	test("a mid-stream ECONNRESET falls back to polling and exits with the real state", async () => {
		const { context, out, err } = captureContext();
		const waitCalls: WaitForRunOptions[] = [];
		const client = mockClient({
			streamError: new WarrenUnreachableError("warren unreachable: ECONNRESET"),
			wait: row("succeeded"),
			waitCalls,
		});
		const result = await runRun(context, { client }, ARGS);
		expect(result.exitCode).toBe(0);
		expect(result.state).toBe("succeeded");
		expect(waitCalls[0]?.timeoutMs).toBe(TAIL_FAILED_TERMINAL_TIMEOUT_MS);
		expect(err.join("")).toContain("event tail for run run-1 failed");
		expect(err.join("")).toContain("ECONNRESET");
		const lines = parseLines(out);
		expect(lines[0]?.event).toBe("run.spawned");
		expect(lines.at(-1)?.event).toBe("run.terminal");
	});

	test("a 503 event_stream_capacity rejection falls back to polling", async () => {
		const { context, err } = captureContext();
		const waitCalls: WaitForRunOptions[] = [];
		const capacity = new WarrenClientError(
			503,
			"event_stream_capacity",
			"too many concurrent event streams for this client (max 5)",
		);
		const client = mockClient({ streamError: capacity, wait: row("succeeded"), waitCalls });
		const result = await runRun(context, { client }, ARGS);
		expect(result.exitCode).toBe(0);
		expect(waitCalls).toHaveLength(1);
		expect(err.join("")).toContain("too many concurrent event streams");
	});

	test("a failed terminal state after the fallback still exits 1", async () => {
		const { context } = captureContext();
		const client = mockClient({
			streamError: new WarrenUnreachableError("socket hangup"),
			wait: row("failed"),
			waitCalls: [],
		});
		const result = await runRun(context, { client }, ARGS);
		expect(result.exitCode).toBe(1);
		expect(result.state).toBe("failed");
	});

	test("a fallback poll timeout emits run.stream_ended with reason tail_failed", async () => {
		const { context, out } = captureContext();
		const client = mockClient({
			streamError: new WarrenUnreachableError("socket hangup"),
			wait: new WarrenClientError(408, "wait_timeout", "run run-1 did not reach a terminal state"),
			waitCalls: [],
		});
		const result = await runRun(context, { client }, ARGS);
		expect(result.exitCode).toBe(1);
		const ended = parseLines(out).find((l) => l.event === "run.stream_ended");
		expect(ended?.reason).toBe("tail_failed");
		expect(ended?.state).toBe("running");
	});
});

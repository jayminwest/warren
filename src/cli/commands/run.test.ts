import { describe, expect, test } from "bun:test";
import {
	type CreateRunInput,
	type RunEvent,
	type RunRow,
	type SpawnRunResponse,
	type WarrenClient,
	WarrenClientError,
	WarrenUnreachableError,
} from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { runRun } from "./run.ts";

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

function parseLines(chunks: string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function runRow(over: Partial<RunRow> = {}): RunRow {
	return {
		id: "run-1",
		agentName: "claude-code",
		projectId: "prj_1",
		burrowId: "bur-1",
		burrowRunId: "brun-1",
		seedId: null,
		parentRunId: null,
		cloneKind: null,
		mode: "batch",
		renderedAgentJson: {},
		state: "succeeded",
		failureReason: null,
		startedAt: "2026-08-04T00:00:00.000Z",
		endedAt: "2026-08-04T00:01:00.000Z",
		prompt: "do the thing",
		trigger: "cli",
		prUrl: "https://github.com/os-eco/warren/pull/42",
		targetBranch: null,
		salvageRef: null,
		salvagePath: null,
		costUsd: 0.01,
		tokensInput: 10,
		tokensOutput: 20,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
		previewState: null,
		previewPort: null,
		previewStartedAt: null,
		previewLastHitAt: null,
		previewFailureMessage: null,
		...over,
	};
}

function runEvent(seq: number): RunEvent {
	return {
		id: seq,
		runId: "run-1",
		seq,
		ts: `2026-08-04T00:00:0${seq}.000Z`,
		kind: "stdout",
		stream: "stdout",
		payload: { text: `line ${seq}` },
	};
}

interface MockClientInput {
	readonly probeError?: Error;
	readonly createError?: Error;
	readonly events?: readonly RunEvent[];
	readonly streamError?: Error;
	readonly row?: RunRow;
	readonly createCalls?: CreateRunInput[];
	readonly onStream?: (signal?: AbortSignal) => void;
}

/** Mocked WarrenClient (warren-97a2): the run command never touches a DB or a socket. */
function mockClient(input: MockClientInput = {}): WarrenClient {
	const events = input.events ?? [];
	return {
		probe: async () => {
			if (input.probeError !== undefined) throw input.probeError;
		},
		createRun: async (body: CreateRunInput) => {
			input.createCalls?.push(body);
			if (input.createError !== undefined) throw input.createError;
			const spawned: SpawnRunResponse = {
				run: input.row ?? runRow(),
				burrow: { id: "bur-1", workspacePath: "/ws/run-1" },
			};
			return spawned;
		},
		streamRunEvents: (_runId: string, opts?: { signal?: AbortSignal }) =>
			(async function* (): AsyncGenerator<RunEvent, void, void> {
				input.onStream?.(opts?.signal);
				for (const event of events) {
					if (opts?.signal?.aborted === true) {
						throw new DOMException("The operation was aborted", "AbortError");
					}
					yield event;
				}
				if (input.streamError !== undefined) throw input.streamError;
				if (opts?.signal?.aborted === true) {
					throw new DOMException("The operation was aborted", "AbortError");
				}
			})(),
		getRun: async () => input.row ?? runRow(),
	} as unknown as WarrenClient;
}

const ARGS = { agent: "claude-code", project: "prj_1", prompt: "do the thing" };

describe("runRun", () => {
	test("rejects empty agent/project/prompt with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runRun(context, { client: mockClient() }, { ...ARGS, prompt: "" });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("--prompt are all required");
	});

	test("an unreachable server exits 3 before dispatching", async () => {
		const { context, err } = captureContext();
		const createCalls: CreateRunInput[] = [];
		const client = mockClient({
			probeError: new WarrenUnreachableError("connection refused"),
			createCalls,
		});
		const result = await runRun(context, { client }, ARGS);
		expect(result.exitCode).toBe(3);
		expect(err.join("")).toContain("connection refused");
		expect(createCalls).toEqual([]);
	});

	test("dispatches via POST /runs with the trigger + overrides forwarded", async () => {
		const { context } = captureContext();
		const createCalls: CreateRunInput[] = [];
		const result = await runRun(
			context,
			{ client: mockClient({ createCalls }) },
			{ ...ARGS, trigger: "manual", providerOverride: "anthropic", modelOverride: "opus" },
		);
		expect(result.exitCode).toBe(0);
		expect(createCalls).toEqual([
			{
				agent: "claude-code",
				project: "prj_1",
				prompt: "do the thing",
				trigger: "manual",
				providerOverride: "anthropic",
				modelOverride: "opus",
			},
		]);
	});

	test("forwards --max-cost-usd as the per-run spend cap (warren-a63d)", async () => {
		const { context } = captureContext();
		const createCalls: CreateRunInput[] = [];
		await runRun(context, { client: mockClient({ createCalls }) }, { ...ARGS, maxCostUsd: 3.5 });
		expect(createCalls[0]?.maxCostUsd).toBe(3.5);
	});

	test("defaults the trigger label to cli", async () => {
		const { context } = captureContext();
		const createCalls: CreateRunInput[] = [];
		await runRun(context, { client: mockClient({ createCalls }) }, ARGS);
		expect(createCalls[0]?.trigger).toBe("cli");
	});

	test("streams events as NDJSON and exits 0 on succeeded", async () => {
		const { context, out } = captureContext();
		const result = await runRun(
			context,
			{ client: mockClient({ events: [runEvent(1), runEvent(2)] }) },
			ARGS,
		);
		expect(result.exitCode).toBe(0);
		expect(result.runId).toBe("run-1");
		expect(result.state).toBe("succeeded");
		const lines = parseLines(out);
		expect(lines[0]?.event).toBe("run.spawned");
		expect(lines[1]?.event).toBe("run.event");
		expect(lines[1]?.seq).toBe(1);
		expect(lines[2]?.event).toBe("run.event");
		expect(lines[3]?.event).toBe("run.terminal");
		expect(lines[3]?.state).toBe("succeeded");
		expect(lines[3]?.prUrl).toBe("https://github.com/os-eco/warren/pull/42");
	});

	test("a failed terminal state exits 1", async () => {
		const { context } = captureContext();
		const result = await runRun(
			context,
			{ client: mockClient({ row: runRow({ state: "failed", failureReason: "oom_killed" }) }) },
			ARGS,
		);
		expect(result.exitCode).toBe(1);
		expect(result.state).toBe("failed");
	});

	test("a dispatch failure exits 1 with the server error on stderr", async () => {
		const { context, err } = captureContext();
		const client = mockClient({ createError: new Error("unknown agent: nope") });
		const result = await runRun(context, { client }, ARGS);
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("unknown agent");
	});

	test("a mid-stream transport error exits 1", async () => {
		const { context, err } = captureContext();
		const client = mockClient({ streamError: new Error("socket hangup") });
		const result = await runRun(context, { client }, ARGS);
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("socket hangup");
	});

	test("SIGINT detaches the tail without cancelling the remote run (exit 130)", async () => {
		const { context, err } = captureContext();
		let sigintHandler: (() => void) | undefined;
		const client = mockClient({
			events: [runEvent(1)],
			onStream: () => sigintHandler?.(),
		});
		const result = await runRun(
			context,
			{
				client,
				onSigint: (handler) => {
					sigintHandler = handler;
					return () => undefined;
				},
			},
			ARGS,
		);
		expect(result.exitCode).toBe(130);
		expect(err.join("")).toContain("detaching from run run-1");
	});

	test("a non-terminal read-back after the stream closes counts as failed", async () => {
		const { context } = captureContext();
		const result = await runRun(
			context,
			{ client: mockClient({ row: runRow({ state: "running" }) }) },
			ARGS,
		);
		expect(result.exitCode).toBe(1);
		expect(result.state).toBe("failed");
	});
});

describe("runRun output contract (warren-b61e)", () => {
	test("json mode emits a single final document and suppresses the stream", async () => {
		const { context, out } = captureContext();
		const jsonContext: CliContext = { ...context, output: "json" };
		const result = await runRun(
			jsonContext,
			{ client: mockClient({ events: [runEvent(1), runEvent(2)] }) },
			ARGS,
		);
		expect(result.exitCode).toBe(0);
		const doc = JSON.parse(out.join("")) as Record<string, unknown>;
		expect(doc.event).toBe("run.terminal");
		expect(doc.state).toBe("succeeded");
		expect(out.join("")).not.toContain("run.event");
		expect(out.join("")).not.toContain("run.spawned");
	});

	test("pretty mode renders a dispatch line, pretty events, and a terminal glyph", async () => {
		const { context, out } = captureContext();
		const prettyContext: CliContext = { ...context, output: "pretty" };
		const result = await runRun(
			prettyContext,
			{ client: mockClient({ events: [runEvent(1)] }) },
			ARGS,
		);
		expect(result.exitCode).toBe(0);
		const text = out.join("");
		expect(text).toContain("▶ run run-1 dispatched");
		expect(text).toContain("[00:00:01]");
		expect(text).toContain("✔ run run-1 succeeded");
		expect(text).toContain("https://github.com/os-eco/warren/pull/42");
	});

	test("an auth rejection during dispatch exits 4", async () => {
		const { context, err } = captureContext();
		const client = mockClient({
			createError: new WarrenClientError(401, "unauthorized", "bad token"),
		});
		const result = await runRun(context, { client }, ARGS);
		expect(result.exitCode).toBe(4);
		expect(err.join("")).toContain("bad token");
	});
});

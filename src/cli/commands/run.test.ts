import { describe, expect, test } from "bun:test";
import {
	type CreateRunInput,
	type RunEvent,
	type RunRow,
	type SpawnRunResponse,
	type WaitForRunOptions,
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
	/** Final row returned by waitForRun / getRun once terminal (or the only snap). */
	readonly row?: RunRow;
	/**
	 * Sequence of getRun/waitForRun snapshots after the stream closes
	 * (warren-22cf). When set, waitForRun walks the list and only resolves
	 * once a terminal state appears (or throws wait_timeout if none does).
	 */
	readonly waitRows?: readonly RunRow[];
	readonly waitError?: Error;
	readonly createCalls?: CreateRunInput[];
	readonly waitCalls?: WaitForRunOptions[];
	readonly onStream?: (signal?: AbortSignal) => void;
}

function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

function waitTimeout(opts: WaitForRunOptions, lastState: string): WarrenClientError {
	return new WarrenClientError(
		408,
		"wait_timeout",
		`run run-1 did not reach a terminal state within ${opts.timeoutMs ?? 0}ms (last state: ${lastState})`,
	);
}

/** Resolve waitForRun against a row sequence or a single final row (warren-22cf). */
function resolveWaitRow(input: MockClientInput, opts: WaitForRunOptions): RunRow {
	if (input.waitError !== undefined) throw input.waitError;
	const sequence = input.waitRows;
	if (sequence !== undefined) {
		const terminal = sequence.find((row) => isTerminal(row.state));
		if (terminal !== undefined) return terminal;
		const last = sequence[sequence.length - 1] ?? runRow({ state: "running" });
		throw waitTimeout(opts, last.state);
	}
	const row = input.row ?? runRow();
	if (!isTerminal(row.state)) throw waitTimeout(opts, row.state);
	return row;
}

/** Mocked WarrenClient (warren-97a2): the run command never touches a DB or a socket. */
function mockClient(input: MockClientInput = {}): WarrenClient {
	const events = input.events ?? [];
	let snapIdx = 0;
	const nextSnap = (): RunRow => {
		const sequence = input.waitRows;
		if (sequence !== undefined && sequence.length > 0) {
			const row = sequence[Math.min(snapIdx, sequence.length - 1)] ?? runRow();
			snapIdx += 1;
			return row;
		}
		return input.row ?? runRow();
	};
	return {
		probe: async () => {
			if (input.probeError !== undefined) throw input.probeError;
		},
		createRun: async (body: CreateRunInput) => {
			input.createCalls?.push(body);
			if (input.createError !== undefined) throw input.createError;
			const spawned: SpawnRunResponse = {
				run: input.row ?? runRow({ state: "running", endedAt: null }),
				sandbox: { id: "bur-1", workspacePath: "/ws/run-1" },
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
		getRun: async () => nextSnap(),
		waitForRun: async (_runId: string, opts: WaitForRunOptions = {}) => {
			input.waitCalls?.push(opts);
			return resolveWaitRow(input, opts);
		},
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

	test("forwards --seed as seedId on POST /runs (warren-ca2f)", async () => {
		const { context } = captureContext();
		const createCalls: CreateRunInput[] = [];
		await runRun(
			context,
			{ client: mockClient({ createCalls }) },
			{ ...ARGS, seedId: "warren-ca2f" },
		);
		expect(createCalls[0]?.seedId).toBe("warren-ca2f");
	});

	test("omits seedId when --seed is not given", async () => {
		const { context } = captureContext();
		const createCalls: CreateRunInput[] = [];
		await runRun(context, { client: mockClient({ createCalls }) }, ARGS);
		expect(createCalls[0]?.seedId).toBeUndefined();
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

	test("polls past a non-terminal stream close until the true terminal state (warren-22cf)", async () => {
		const { context, out } = captureContext();
		const waitCalls: WaitForRunOptions[] = [];
		const result = await runRun(
			context,
			{
				client: mockClient({
					events: [runEvent(1)],
					waitCalls,
					waitRows: [
						runRow({ state: "running", endedAt: null, prUrl: null }),
						runRow({ state: "succeeded" }),
					],
				}),
				waitForRunOptions: { intervalMs: 1, timeoutMs: 5_000 },
			},
			ARGS,
		);
		expect(result.exitCode).toBe(0);
		expect(result.state).toBe("succeeded");
		expect(waitCalls).toHaveLength(1);
		expect(waitCalls[0]?.timeoutMs).toBe(5_000);
		const lines = parseLines(out);
		const terminal = lines.find((l) => l.event === "run.terminal");
		expect(terminal?.state).toBe("succeeded");
		expect(lines.some((l) => l.event === "run.stream_ended")).toBe(false);
	});

	test("a post-stream wait timeout emits run.stream_ended, not a bogus terminal (warren-22cf)", async () => {
		const { context, out, err } = captureContext();
		const result = await runRun(
			context,
			{
				client: mockClient({
					events: [runEvent(1)],
					waitRows: [runRow({ state: "running", endedAt: null, prUrl: null })],
				}),
				waitForRunOptions: { intervalMs: 1, timeoutMs: 10 },
			},
			ARGS,
		);
		expect(result.exitCode).toBe(1);
		expect(result.state).toBeUndefined();
		const lines = parseLines(out);
		const ended = lines.find((l) => l.event === "run.stream_ended");
		expect(ended).toBeDefined();
		expect(ended?.state).toBe("running");
		expect(ended?.reason).toBe("await_terminal_timeout");
		expect(lines.some((l) => l.event === "run.terminal")).toBe(false);
		expect(err.join("")).toContain("did not reach a terminal state");
	});

	test("pretty mode names the stream-ended-but-not-terminal case (warren-22cf)", async () => {
		const { context, out } = captureContext();
		const prettyContext: CliContext = { ...context, output: "pretty" };
		const result = await runRun(
			prettyContext,
			{
				client: mockClient({
					waitRows: [runRow({ state: "running", endedAt: null, prUrl: null })],
				}),
				waitForRunOptions: { intervalMs: 1, timeoutMs: 10 },
			},
			ARGS,
		);
		expect(result.exitCode).toBe(1);
		const text = out.join("");
		expect(text).toContain("stream ended but run is not terminal yet");
		expect(text).toContain("last state: running");
		expect(text).not.toContain("run.terminal");
		expect(text).not.toMatch(/✔ run run-1/);
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

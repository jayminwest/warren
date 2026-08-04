import { describe, expect, test } from "bun:test";
import type { RunEvent, StreamRunEventsOptions, WarrenClient } from "../../client/index.ts";
import type { CliContext, OutputMode } from "../output.ts";
import { runTail } from "./tail.ts";

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

function parseLines(chunks: string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function event(over: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 1,
		runId: "run-1",
		seq: 1,
		ts: "2026-08-04T00:00:00.000Z",
		kind: "text",
		stream: "stdout",
		payload: { text: "hello from the agent" },
		...over,
	};
}

interface MockClientInput {
	events?: RunEvent[];
	probeError?: Error;
	streamError?: Error;
	seenOpts?: StreamRunEventsOptions[];
}

function mockClient(input: MockClientInput = {}): WarrenClient {
	const events = input.events ?? [];
	return {
		probe: async () => {
			if (input.probeError !== undefined) throw input.probeError;
		},
		streamRunEvents: (_runId: string, opts: StreamRunEventsOptions = {}) =>
			(async function* (): AsyncGenerator<RunEvent, void, void> {
				input.seenOpts?.push(opts);
				for (const e of events) {
					yield e;
				}
				if (input.streamError !== undefined) throw input.streamError;
			})(),
	} as unknown as WarrenClient;
}

describe("runTail", () => {
	test("rejects-empty-run-id-with-exit-2", async () => {
		const { context, err } = captureContext();
		const res = await runTail(context, { client: mockClient() }, { runId: "" });
		expect(res.exitCode).toBe(2);
		expect(err.join("")).toContain("required");
	});

	test("reports-unreachable-warren-with-exit-3", async () => {
		const { context } = captureContext();
		const res = await runTail(
			context,
			{ client: mockClient({ probeError: new Error("warren unreachable") }) },
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(3);
	});

	test("ndjson-emits-one-raw-event-per-line", async () => {
		const { context, out } = captureContext();
		const res = await runTail(
			context,
			{ client: mockClient({ events: [event(), event({ id: 2, seq: 2 })] }) },
			{ runId: "run-1", follow: false },
		);
		expect(res.exitCode).toBe(0);
		const lines = parseLines(out);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ runId: "run-1", seq: 1, kind: "text" });
	});

	test("pretty-renders-via-the-shared-event-line-seam", async () => {
		const { context, out } = captureContext("pretty");
		const res = await runTail(
			context,
			{ client: mockClient({ events: [event()] }) },
			{ runId: "run-1", follow: false },
		);
		expect(res.exitCode).toBe(0);
		expect(out.join("")).toContain("assistant: hello from the agent");
	});

	test("forwards-follow-and-from-seq-to-the-sdk", async () => {
		const { context } = captureContext();
		const seenOpts: StreamRunEventsOptions[] = [];
		await runTail(
			context,
			{ client: mockClient({ seenOpts }) },
			{ runId: "run-1", follow: false, fromSeq: 41 },
		);
		expect(seenOpts[0]?.follow).toBe(false);
		expect(seenOpts[0]?.sinceSeq).toBe(41);
	});

	test("defaults-follow-to-true", async () => {
		const { context } = captureContext();
		const seenOpts: StreamRunEventsOptions[] = [];
		await runTail(context, { client: mockClient({ seenOpts }) }, { runId: "run-1" });
		expect(seenOpts[0]?.follow).toBe(true);
	});

	test("maps-a-stream-error-to-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runTail(
			context,
			{ client: mockClient({ streamError: new Error("stream died") }) },
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(1);
		expect(err.join("")).toContain("stream died");
	});

	test("sigint-detaches-the-local-tail-with-exit-130", async () => {
		const { context, err } = captureContext();
		let sigintHandler: (() => void) | undefined;
		const detachClient = {
			probe: async () => undefined,
			streamRunEvents: () =>
				(async function* (): AsyncGenerator<RunEvent, void, void> {
					yield event();
					// Mid-tail SIGINT: prints the detach hint and aborts the stream.
					sigintHandler?.();
					throw new DOMException("The operation was aborted", "AbortError");
				})(),
		} as unknown as WarrenClient;
		const res = await runTail(
			context,
			{
				client: detachClient,
				onSigint: (handler) => {
					sigintHandler = handler;
					return () => {};
				},
			},
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(130);
		expect(err.join("")).toContain("detaching from run run-1");
	});
});

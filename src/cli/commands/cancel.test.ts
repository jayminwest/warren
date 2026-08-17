import { describe, expect, test } from "bun:test";
import type { CancelRunInput, CancelRunResponse, WarrenClient } from "../../client/index.ts";
import type { CliContext, OutputMode } from "../output.ts";
import { runCancel } from "./cancel.ts";

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
			// Sinks capture chunks for assertions.
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		...(output !== undefined ? { output } : {}),
	};
	return { context, out, err };
}

function cancelResponse(over: Partial<CancelRunResponse> = {}): CancelRunResponse {
	return {
		state: "cancelled",
		alreadyTerminal: false,
		sandboxRun: { id: "brun-1", state: "cancelled" },
		...over,
	};
}

interface ClientOverrides {
	probe?: () => Promise<void>;
	cancelRun?: (runId: string, input: CancelRunInput) => Promise<CancelRunResponse>;
}

function client(over: ClientOverrides = {}) {
	return {
		probe: over.probe ?? (async () => undefined),
		cancelRun: over.cancelRun ?? (async () => cancelResponse()),
	} as unknown as WarrenClient;
}

describe("runCancel", () => {
	test("rejects-empty-run-id-with-exit-2", async () => {
		const { context, err } = captureContext();
		const res = await runCancel(context, { client: client() }, { runId: "" });
		expect(res.exitCode).toBe(2);
		expect(err.join("")).toContain("required");
	});

	test("reports-unreachable-warren-with-exit-3", async () => {
		const { context } = captureContext();
		const res = await runCancel(
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

	test("ndjson-emits-the-cancel-response", async () => {
		const { context, out } = captureContext();
		const res = await runCancel(context, { client: client() }, { runId: "run-1" });
		expect(res.exitCode).toBe(0);
		expect(res.alreadyTerminal).toBe(false);
		const parsed = JSON.parse(out.join("")) as CancelRunResponse;
		expect(parsed.state).toBe("cancelled");
		expect(parsed.sandboxRun?.id).toBe("brun-1");
	});

	test("forwards-the-reason-to-the-sdk", async () => {
		const { context } = captureContext();
		let seen: CancelRunInput | undefined;
		await runCancel(
			context,
			{
				client: client({
					cancelRun: async (_id, input) => {
						seen = input;
						return cancelResponse();
					},
				}),
			},
			{ runId: "run-1", reason: "superseded by run-2" },
		);
		expect(seen?.reason).toBe("superseded by run-2");
	});

	test("already-terminal-cancels-still-exit-0", async () => {
		const { context, out } = captureContext("pretty");
		const res = await runCancel(
			context,
			{
				client: client({
					cancelRun: async () =>
						cancelResponse({ state: "succeeded", alreadyTerminal: true, sandboxRun: null }),
				}),
			},
			{ runId: "run-1" },
		);
		expect(res.exitCode).toBe(0);
		expect(res.alreadyTerminal).toBe(true);
		expect(out.join("")).toContain("already succeeded — nothing to cancel");
	});

	test("pretty-renders-a-cancelled-line", async () => {
		const { context, out } = captureContext("pretty");
		await runCancel(context, { client: client() }, { runId: "run-1" });
		expect(out.join("")).toContain("■ run run-1 cancelled");
	});

	test("maps-a-cancelRun-failure-to-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runCancel(
			context,
			{
				client: client({
					cancelRun: async () => {
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

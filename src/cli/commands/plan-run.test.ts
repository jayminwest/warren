import { describe, expect, test } from "bun:test";
import type { WarrenClient } from "../../client/index.ts";
import type {
	CancelPlanRunResponse,
	CreatePlanRunInput,
	CreatePlanRunResponse,
	PlanRunDetailResponse,
	PlanRunState,
	RunEvent,
} from "../../client/types.ts";
import type { CliContext } from "../output.ts";
import { type PlanRunDeps, runPlanCancel, runPlanRun, type SigintDisposer } from "./plan-run.ts";

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

function parseLines(chunks: string[]): unknown[] {
	return chunks
		.join("")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

interface FakeClientOverrides {
	probe?: () => Promise<void>;
	createPlanRun?: (input: CreatePlanRunInput) => Promise<CreatePlanRunResponse>;
	streamEvents?: () => AsyncGenerator<RunEvent, void, void>;
	getPlanRun?: () => Promise<PlanRunDetailResponse>;
	cancelPlanRun?: () => Promise<CancelPlanRunResponse>;
}

function planRunRow(state: PlanRunState) {
	return {
		id: "pr-1",
		planId: "pl-abc",
		projectId: "prj_1",
		agentName: "claude-code",
		promptTemplate: "",
		ref: null,
		providerOverride: null,
		modelOverride: null,
		dispatcherHandle: "cli",
		trigger: "cli",
		state,
		failureReason: null,
		createdAt: "t",
		startedAt: null,
		endedAt: null,
		plotId: null,
	};
}

function fakeClient(over: FakeClientOverrides = {}): WarrenClient {
	const client = {
		probe: over.probe ?? (async () => undefined),
		createPlanRun:
			over.createPlanRun ?? (async () => ({ planRun: planRunRow("queued"), children: [] })),
		streamPlanRunEvents:
			over.streamEvents ??
			async function* () {
				// no events by default
			},
		getPlanRun:
			over.getPlanRun ??
			(async () => ({ planRun: planRunRow("succeeded"), children: [], runs: [] })),
		cancelPlanRun:
			over.cancelPlanRun ??
			(async () => ({
				planRun: planRunRow("cancelled"),
				cancelledChild: null,
				alreadyTerminal: false,
			})),
	};
	return client as unknown as WarrenClient;
}

function baseArgs(over: Partial<Parameters<typeof runPlanRun>[2]> = {}) {
	return {
		planId: "pl-abc",
		project: "prj_1",
		agent: "claude-code",
		follow: true,
		...over,
	};
}

describe("runPlanRun", () => {
	test("rejects-missing-required-args-with-exit-2", async () => {
		const { context, err } = captureContext();
		const res = await runPlanRun(context, { client: fakeClient() }, baseArgs({ project: "" }));
		expect(res.exitCode).toBe(2);
		expect(err.join("")).toContain("required");
	});

	test("reports-unreachable-warren-from-probe-with-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runPlanRun(
			context,
			{
				client: fakeClient({
					probe: async () => {
						throw new Error("warren unreachable at http://w.local");
					},
				}),
			},
			baseArgs(),
		);
		expect(res.exitCode).toBe(1);
		expect(err.join("")).toContain("unreachable");
	});

	test("dispatches-tails-and-maps-succeeded-to-exit-0", async () => {
		const { context, out } = captureContext();
		const events: RunEvent[] = [
			{
				id: 1,
				runId: "run-a",
				seq: 1,
				ts: "t",
				kind: "tool_use",
				stream: "stdout",
				payload: {},
				plotId: null,
			},
		];
		const res = await runPlanRun(
			context,
			{
				client: fakeClient({
					streamEvents: async function* () {
						for (const e of events) yield e;
					},
				}),
			},
			baseArgs(),
		);
		expect(res.exitCode).toBe(0);
		expect(res.state).toBe("succeeded");
		const lines = parseLines(out) as Array<{ event: string }>;
		expect(lines.map((l) => l.event)).toEqual([
			"plan_run.dispatched",
			"plan_run.event",
			"plan_run.terminal",
		]);
	});

	test("maps-failed-terminal-state-to-exit-1", async () => {
		const { context } = captureContext();
		const res = await runPlanRun(
			context,
			{
				client: fakeClient({
					getPlanRun: async () => ({ planRun: planRunRow("failed"), children: [], runs: [] }),
				}),
			},
			baseArgs(),
		);
		expect(res.exitCode).toBe(1);
		expect(res.state).toBe("failed");
	});

	test("no-follow-dispatches-and-exits-0-without-tailing", async () => {
		const { context, out } = captureContext();
		let streamed = false;
		const res = await runPlanRun(
			context,
			{
				client: fakeClient({
					streamEvents: async function* () {
						streamed = true;
						yield {
							id: 1,
							runId: "r",
							seq: 1,
							ts: "t",
							kind: "k",
							stream: null,
							payload: {},
							plotId: null,
						};
					},
				}),
			},
			baseArgs({ follow: false }),
		);
		expect(res.exitCode).toBe(0);
		expect(streamed).toBe(false);
		const lines = parseLines(out) as Array<{ event: string }>;
		expect(lines.map((l) => l.event)).toEqual(["plan_run.dispatched"]);
	});

	test("forwards-optional-overrides-into-create-body", async () => {
		const { context } = captureContext();
		let observed: CreatePlanRunInput | undefined;
		await runPlanRun(
			context,
			{
				client: fakeClient({
					createPlanRun: async (input) => {
						observed = input;
						return { planRun: planRunRow("queued"), children: [] };
					},
				}),
			},
			baseArgs({
				follow: false,
				promptTemplate: "tmpl",
				ref: "main",
				provider: "anthropic",
				model: "opus",
				plot: "plot-x",
			}),
		);
		expect(observed).toEqual({
			planId: "pl-abc",
			project: "prj_1",
			agent: "claude-code",
			promptTemplate: "tmpl",
			ref: "main",
			providerOverride: "anthropic",
			modelOverride: "opus",
			plotId: "plot-x",
		});
	});

	test("sigint-detaches-tail-without-cancelling-and-exits-130", async () => {
		const { context, err } = captureContext();
		let fireSigint: (() => void) | undefined;
		const onSigint = (handler: () => void): SigintDisposer => {
			fireSigint = handler;
			return () => undefined;
		};
		const deps: PlanRunDeps = {
			client: fakeClient({
				streamEvents: async function* () {
					// Trigger SIGINT mid-stream, then block on an abortable wait.
					fireSigint?.();
					await new Promise<void>((_, reject) => {
						const e = new Error("aborted");
						e.name = "AbortError";
						reject(e);
					});
				},
			}),
			onSigint,
		};
		const res = await runPlanRun(context, deps, baseArgs());
		expect(res.exitCode).toBe(130);
		expect(err.join("")).toContain("detaching from plan-run");
	});

	test("second-sigint-force-exits", async () => {
		const { context } = captureContext();
		let fireSigint: (() => void) | undefined;
		let exitCode: number | undefined;
		const deps: PlanRunDeps = {
			client: fakeClient({
				streamEvents: async function* () {
					fireSigint?.();
					fireSigint?.();
					yield {
						id: 1,
						runId: "r",
						seq: 1,
						ts: "t",
						kind: "k",
						stream: null,
						payload: {},
						plotId: null,
					};
				},
			}),
			onSigint: (handler) => {
				fireSigint = handler;
				return () => undefined;
			},
			exit: ((code: number) => {
				exitCode = code;
				throw new Error("exit");
			}) as (code: number) => never,
		};
		await runPlanRun(context, deps, baseArgs()).catch(() => undefined);
		expect(exitCode).toBe(130);
	});
});

describe("runPlanCancel", () => {
	test("cancels-and-prints-summary-with-exit-0", async () => {
		const { context, out } = captureContext();
		const res = await runPlanCancel(context, { client: fakeClient() }, { planRunId: "pr-1" });
		expect(res.exitCode).toBe(0);
		const lines = parseLines(out) as Array<{ event: string }>;
		expect(lines.map((l) => l.event)).toEqual(["plan_run.cancelled"]);
	});

	test("rejects-empty-id-with-exit-2", async () => {
		const { context } = captureContext();
		const res = await runPlanCancel(context, { client: fakeClient() }, { planRunId: "" });
		expect(res.exitCode).toBe(2);
	});

	test("reports-cancel-failure-with-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runPlanCancel(
			context,
			{
				client: fakeClient({
					cancelPlanRun: async () => {
						throw new Error("boom");
					},
				}),
			},
			{ planRunId: "pr-1" },
		);
		expect(res.exitCode).toBe(1);
		expect(err.join("")).toContain("boom");
	});
});

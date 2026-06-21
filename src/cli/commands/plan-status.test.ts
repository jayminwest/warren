import { describe, expect, test } from "bun:test";
import type { WarrenClient } from "../../client/index.ts";
import type {
	ListPlanRunsFilter,
	ListPlanRunsResponse,
	PlanRunChildRow,
	PlanRunDetailResponse,
	PlanRunRow,
	PlanRunState,
	RunRow,
} from "../../client/types.ts";
import type { CliContext } from "../output.ts";
import { runPlanList, runPlanStatus } from "./plan-status.ts";

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

function planRunRow(over: Partial<PlanRunRow> = {}): PlanRunRow {
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
		state: "running",
		failureReason: null,
		createdAt: "2026-06-21T08:00:00.000Z",
		startedAt: null,
		endedAt: null,
		plotId: null,
		...over,
	};
}

function childRow(over: Partial<PlanRunChildRow> = {}): PlanRunChildRow {
	return {
		planRunId: "pr-1",
		seq: 1,
		seedId: "warren-aaaa",
		runId: null,
		state: "pending",
		createdAt: "t",
		updatedAt: "t",
		startedAt: null,
		endedAt: null,
		prMergedAt: null,
		failureReason: null,
		...over,
	};
}

function runRow(over: Partial<RunRow> = {}): RunRow {
	return {
		id: "run-a",
		agentName: "claude-code",
		projectId: "prj_1",
		burrowId: null,
		burrowRunId: null,
		seedId: null,
		plotId: null,
		parentRunId: null,
		cloneKind: null,
		mode: "batch",
		renderedAgentJson: {},
		state: "succeeded",
		failureReason: null,
		startedAt: "2026-06-21T08:00:00.000Z",
		endedAt: "2026-06-21T08:00:12.500Z",
		prompt: "",
		trigger: "cli",
		prUrl: null,
		costUsd: 0.1234,
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

interface StatusOverrides {
	probe?: () => Promise<void>;
	getPlanRun?: () => Promise<PlanRunDetailResponse>;
}

function statusClient(over: StatusOverrides = {}): WarrenClient {
	return {
		probe: over.probe ?? (async () => undefined),
		getPlanRun:
			over.getPlanRun ?? (async () => ({ planRun: planRunRow(), children: [], runs: [] })),
	} as unknown as WarrenClient;
}

interface ListOverrides {
	probe?: () => Promise<void>;
	listPlanRuns?: (filter: ListPlanRunsFilter) => Promise<ListPlanRunsResponse>;
}

function listClient(over: ListOverrides = {}): WarrenClient {
	return {
		probe: over.probe ?? (async () => undefined),
		listPlanRuns: over.listPlanRuns ?? (async () => ({ planRuns: [] })),
	} as unknown as WarrenClient;
}

describe("runPlanStatus", () => {
	test("rejects-empty-id-with-exit-2", async () => {
		const { context, err } = captureContext();
		const res = await runPlanStatus(context, { client: statusClient() }, { planRunId: "" });
		expect(res.exitCode).toBe(2);
		expect(err.join("")).toContain("required");
	});

	test("reports-unreachable-warren-with-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runPlanStatus(
			context,
			{
				client: statusClient({
					probe: async () => {
						throw new Error("warren unreachable at http://w.local");
					},
				}),
			},
			{ planRunId: "pr-1" },
		);
		expect(res.exitCode).toBe(1);
		expect(err.join("")).toContain("unreachable");
	});

	test("ndjson-emits-the-detail-envelope", async () => {
		const { context, out } = captureContext();
		const detail: PlanRunDetailResponse = {
			planRun: planRunRow(),
			children: [childRow()],
			runs: [],
		};
		const res = await runPlanStatus(
			context,
			{ client: statusClient({ getPlanRun: async () => detail }) },
			{ planRunId: "pr-1" },
		);
		expect(res.exitCode).toBe(0);
		expect(res.state).toBe("running");
		const [line] = parseLines(out) as [PlanRunDetailResponse];
		expect(line.planRun.id).toBe("pr-1");
		expect(line.children).toHaveLength(1);
	});

	test("pretty-renders-child-cost-and-duration-from-runs", async () => {
		const { context, out } = captureContext();
		const detail: PlanRunDetailResponse = {
			planRun: planRunRow({ state: "succeeded" }),
			children: [childRow({ runId: "run-a", state: "merged" })],
			runs: [runRow()],
		};
		const res = await runPlanStatus(
			context,
			{ client: statusClient({ getPlanRun: async () => detail }) },
			{ planRunId: "pr-1", output: "pretty" },
		);
		expect(res.exitCode).toBe(0);
		const text = out.join("");
		expect(text).toContain("plan-run pr-1 [succeeded]");
		expect(text).toContain("warren-aaaa");
		expect(text).toContain("$0.1234");
		expect(text).toContain("12.5s");
		expect(text).not.toContain('"planRun"');
	});

	test("pretty-falls-back-to-em-dash-for-childless-or-runless", async () => {
		const { context, out } = captureContext();
		const detail: PlanRunDetailResponse = {
			planRun: planRunRow(),
			children: [childRow()],
			runs: [],
		};
		await runPlanStatus(
			context,
			{ client: statusClient({ getPlanRun: async () => detail }) },
			{ planRunId: "pr-1", output: "pretty" },
		);
		expect(out.join("")).toContain("—");
	});

	test("reports-get-failure-with-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runPlanStatus(
			context,
			{
				client: statusClient({
					getPlanRun: async () => {
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

describe("runPlanList", () => {
	test("reports-unreachable-warren-with-exit-1", async () => {
		const { context, err } = captureContext();
		const res = await runPlanList(
			context,
			{
				client: listClient({
					probe: async () => {
						throw new Error("warren unreachable");
					},
				}),
			},
			{},
		);
		expect(res.exitCode).toBe(1);
		expect(err.join("")).toContain("unreachable");
	});

	test("ndjson-emits-one-line-per-plan-run", async () => {
		const { context, out } = captureContext();
		const res = await runPlanList(
			context,
			{
				client: listClient({
					listPlanRuns: async () => ({
						planRuns: [planRunRow(), planRunRow({ id: "pr-2" })],
					}),
				}),
			},
			{},
		);
		expect(res.exitCode).toBe(0);
		expect(res.count).toBe(2);
		const lines = parseLines(out) as PlanRunRow[];
		expect(lines.map((l) => l.id)).toEqual(["pr-1", "pr-2"]);
	});

	test("forwards-project-and-state-filters", async () => {
		const { context } = captureContext();
		let observed: ListPlanRunsFilter | undefined;
		await runPlanList(
			context,
			{
				client: listClient({
					listPlanRuns: async (filter) => {
						observed = filter;
						return { planRuns: [] };
					},
				}),
			},
			{ project: "prj_9", state: "failed" as PlanRunState },
		);
		expect(observed).toEqual({ project: "prj_9", state: "failed" });
	});

	test("pretty-renders-a-table-header", async () => {
		const { context, out } = captureContext();
		await runPlanList(
			context,
			{
				client: listClient({
					listPlanRuns: async () => ({ planRuns: [planRunRow()] }),
				}),
			},
			{ output: "pretty" },
		);
		const text = out.join("");
		expect(text).toContain("id");
		expect(text).toContain("pr-1");
		expect(text).toContain("pl-abc");
	});

	test("pretty-renders-empty-marker", async () => {
		const { context, out } = captureContext();
		await runPlanList(context, { client: listClient() }, { output: "pretty" });
		expect(out.join("")).toContain("(no plan-runs)");
	});
});

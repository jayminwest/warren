import { describe, expect, test } from "bun:test";
import type { ConversationRow } from "../db/schema.ts";
import {
	bootConversationMergePoller,
	buildPlannerDispatchPrompt,
	CONVERSATION_PLANNER_DISPATCHED_KIND,
	DEFAULT_PLANNER_AGENT,
	type MergePollTickDeps,
	type PlannerDispatchInput,
	tickConversationMergePoller,
} from "./conversation-merge-poller.ts";
import type { CheckPrMergedResult } from "./pr.ts";

function conv(over: Partial<ConversationRow> = {}): ConversationRow {
	return {
		id: "conv_1",
		projectId: "proj_1",
		plotId: "plot-abc",
		anchoringRunId: "run_anchor",
		status: "closed",
		title: null,
		submittedPrUrl: "https://github.com/x/y/pull/1",
		submittedPrNumber: 1,
		plannerAgent: null,
		plannerRunId: null,
		createdAt: "2026-06-06T00:00:00.000Z",
		lastActivityAt: "2026-06-06T00:00:00.000Z",
		closedAt: "2026-06-06T00:00:00.000Z",
		...over,
	};
}

interface Harness {
	readonly deps: MergePollTickDeps;
	readonly dispatchCalls: PlannerDispatchInput[];
	readonly recordCalls: { id: string; runId: string }[];
	readonly events: { runId: string; kind: string; ts: string; payload: Record<string, unknown> }[];
}

function harness(input: {
	rows: ConversationRow[];
	merge: CheckPrMergedResult;
	dispatchRunId?: string;
	recordReturnsNull?: boolean;
}): Harness {
	const dispatchCalls: PlannerDispatchInput[] = [];
	const recordCalls: { id: string; runId: string }[] = [];
	const events: { runId: string; kind: string; ts: string; payload: Record<string, unknown> }[] =
		[];
	let rows = input.rows;
	const deps: MergePollTickDeps = {
		repos: {
			conversations: {
				listAwaitingPlannerDispatch: async () => rows,
				recordPlannerDispatch: async (id: string, runId: string) => {
					recordCalls.push({ id, runId });
					if (input.recordReturnsNull === true) return null;
					const row = rows.find((r) => r.id === id) ?? null;
					rows = rows.map((r) => (r.id === id ? { ...r, plannerRunId: runId } : r));
					return row === null ? null : { ...row, plannerRunId: runId };
				},
			},
			events: {
				maxSeqForRun: async () => 0,
				append: async (e: { runId: string; kind: string; ts: string; payload: unknown }) => {
					events.push({
						runId: e.runId,
						kind: e.kind,
						ts: e.ts,
						payload: e.payload as Record<string, unknown>,
					});
					return undefined as never;
				},
			},
			// biome-ignore lint/suspicious/noExplicitAny: narrow test stub
		} as any,
		checkPrMerged: async () => input.merge,
		dispatch: async (di) => {
			dispatchCalls.push(di);
			return { runId: input.dispatchRunId ?? "run_planner" };
		},
		now: () => new Date("2026-06-07T00:00:00.000Z"),
	};
	return { deps, dispatchCalls, recordCalls, events };
}

describe("buildPlannerDispatchPrompt", () => {
	test("names the plot and forbids self-dispatch", () => {
		const prompt = buildPlannerDispatchPrompt("plot-xyz");
		expect(prompt).toContain("plot-xyz");
		expect(prompt).toContain("Do NOT dispatch");
	});
});

describe("tickConversationMergePoller", () => {
	test("dispatches the planner when the send-off PR is merged", async () => {
		const h = harness({
			rows: [conv()],
			merge: { kind: "merged", mergedAt: "2026-06-06T12:00:00.000Z" },
		});
		const result = await tickConversationMergePoller(h.deps);

		expect(result.dispatched).toEqual([
			{ conversationId: "conv_1", plotId: "plot-abc", plannerRunId: "run_planner" },
		]);
		expect(result.waiting).toEqual([]);
		expect(h.dispatchCalls).toEqual([
			{
				conversationId: "conv_1",
				projectId: "proj_1",
				plotId: "plot-abc",
				plannerAgent: DEFAULT_PLANNER_AGENT,
			},
		]);
		expect(h.recordCalls).toEqual([{ id: "conv_1", runId: "run_planner" }]);
		expect(h.events).toHaveLength(1);
		expect(h.events[0]?.kind).toBe(CONVERSATION_PLANNER_DISPATCHED_KIND);
		expect(h.events[0]?.runId).toBe("run_planner");
		expect(h.events[0]?.payload.plotId).toBe("plot-abc");
		// The envelope `ts` is stamped from the injected `now` clock (warren-96fd),
		// matching the payload's `dispatchedAt` written in the same append.
		expect(h.events[0]?.ts).toBe("2026-06-07T00:00:00.000Z");
		expect(h.events[0]?.payload.dispatchedAt).toBe("2026-06-07T00:00:00.000Z");
	});

	test("honors a pinned planner agent from the send-off", async () => {
		const h = harness({
			rows: [conv({ plannerAgent: "custom-planner" })],
			merge: { kind: "merged", mergedAt: "2026-06-06T12:00:00.000Z" },
		});
		await tickConversationMergePoller(h.deps);
		expect(h.dispatchCalls[0]?.plannerAgent).toBe("custom-planner");
	});

	test("waits (no dispatch) when the PR is still open", async () => {
		const h = harness({ rows: [conv()], merge: { kind: "open" } });
		const result = await tickConversationMergePoller(h.deps);
		expect(result.dispatched).toEqual([]);
		expect(result.waiting).toEqual([{ conversationId: "conv_1", reason: "open" }]);
		expect(h.dispatchCalls).toEqual([]);
	});

	test("waits when the PR is closed-unmerged and never dispatches", async () => {
		const h = harness({ rows: [conv()], merge: { kind: "closed_unmerged" } });
		const result = await tickConversationMergePoller(h.deps);
		expect(result.waiting).toEqual([{ conversationId: "conv_1", reason: "closed_unmerged" }]);
		expect(h.dispatchCalls).toEqual([]);
	});

	test("skips a conversation missing its plot or project", async () => {
		const h = harness({
			rows: [conv({ plotId: null })],
			merge: { kind: "merged", mergedAt: "2026-06-06T12:00:00.000Z" },
		});
		const result = await tickConversationMergePoller(h.deps);
		expect(result.dispatched).toEqual([]);
		expect(result.waiting).toEqual([
			{ conversationId: "conv_1", reason: "missing_plot_or_project" },
		]);
		// PR is never polled when there is nothing to key the dispatch on.
		expect(h.dispatchCalls).toEqual([]);
	});

	test("does not emit an event when the dispatch was already recorded (race)", async () => {
		const h = harness({
			rows: [conv()],
			merge: { kind: "merged", mergedAt: "2026-06-06T12:00:00.000Z" },
			recordReturnsNull: true,
		});
		const result = await tickConversationMergePoller(h.deps);
		// Dispatch fired (the seam can't be un-fired) but no event / sink entry.
		expect(h.dispatchCalls).toHaveLength(1);
		expect(result.dispatched).toEqual([]);
		expect(h.events).toEqual([]);
	});
});

describe("bootConversationMergePoller", () => {
	test("runOnce fires a single tick and counts it", async () => {
		const h = harness({
			rows: [conv()],
			merge: { kind: "merged", mergedAt: "2026-06-06T12:00:00.000Z" },
		});
		const poller = bootConversationMergePoller({ ...h.deps, tickMs: 1000, disabled: true });
		const result = await poller.runOnce();
		expect(result?.dispatched).toHaveLength(1);
		expect(poller.tickCount()).toBe(1);
		await poller.stop();
	});

	test("disabled poller installs no interval", async () => {
		const h = harness({ rows: [], merge: { kind: "open" } });
		let installed = false;
		const poller = bootConversationMergePoller({
			...h.deps,
			tickMs: 1000,
			disabled: true,
			setInterval: () => {
				installed = true;
				return {};
			},
			clearInterval: () => {},
		});
		expect(installed).toBe(false);
		await poller.stop();
	});
});

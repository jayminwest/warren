import { describe, expect, test } from "bun:test";
import type {
	CancelPlanRunResponse,
	PlanRunChildRow,
	PlanRunRow,
	RunEvent,
} from "../client/types.ts";
import type { WriteSink } from "./output.ts";
import { createNdjsonRenderer, createPrettyRenderer, createRenderer } from "./plan-run-renderer.ts";

function capture(): { sink: WriteSink; lines: () => string[] } {
	const chunks: string[] = [];
	return {
		sink: { write: (c) => chunks.push(c) },
		lines: () => chunks.join("").split("\n").filter(Boolean),
	};
}

function planRunRow(overrides: Partial<PlanRunRow> = {}): PlanRunRow {
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
		createdAt: "t",
		startedAt: null,
		endedAt: null,
		plotId: null,
		...overrides,
	};
}

function child(seq: number, state: PlanRunChildRow["state"]): PlanRunChildRow {
	return {
		planRunId: "pr-1",
		seq,
		seedId: `wn-${seq}`,
		runId: null,
		state,
		createdAt: "t",
		updatedAt: "t",
		startedAt: null,
		endedAt: null,
		prMergedAt: null,
		failureReason: null,
	};
}

function event(kind: string, payload: unknown, over: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 1,
		runId: "run-a",
		seq: 1,
		ts: "2026-06-21T08:09:10.000Z",
		kind,
		stream: "stdout",
		payload,
		plotId: null,
		...over,
	};
}

describe("createRenderer", () => {
	test("selects-ndjson-by-default", () => {
		const { sink, lines } = capture();
		createRenderer("ndjson", sink).terminal("pr-1", "succeeded");
		expect(JSON.parse(lines()[0] ?? "{}")).toEqual({
			event: "plan_run.terminal",
			planRunId: "pr-1",
			state: "succeeded",
		});
	});

	test("selects-pretty-mode", () => {
		const { sink, lines } = capture();
		createRenderer("pretty", sink).terminal("pr-1", "succeeded");
		expect(lines()[0]).toBe("✔ plan-run pr-1 succeeded");
	});
});

describe("createNdjsonRenderer", () => {
	test("emits-event-with-full-shape", () => {
		const { sink, lines } = capture();
		createNdjsonRenderer(sink).event(event("tool_use", { name: "bash" }));
		expect(JSON.parse(lines()[0] ?? "{}")).toEqual({
			event: "plan_run.event",
			runId: "run-a",
			seq: 1,
			ts: "2026-06-21T08:09:10.000Z",
			kind: "tool_use",
			stream: "stdout",
			payload: { name: "bash" },
		});
	});
});

describe("createPrettyRenderer", () => {
	test("dispatched-prints-summary-and-child-lines", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).dispatched(planRunRow(), [
			child(1, "dispatched"),
			child(2, "pending"),
		]);
		expect(lines()).toEqual([
			"▶ plan-run pr-1 dispatched — plan pl-abc, 2 children (agent claude-code)",
			"  · child #1 wn-1 [dispatched]",
			"  · child #2 wn-2 [pending]",
		]);
	});

	test("renders-assistant-text-with-timestamp", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(event("text", { text: "hello world" }));
		expect(lines()[0]).toBe("[08:09:10] assistant: hello world");
	});

	test("renders-thinking-block", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(event("thinking", { thinking: "let me reason" }));
		expect(lines()[0]).toBe("[08:09:10] thinking: let me reason");
	});

	test("renders-tool-use-command", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(
			event("tool_use", { name: "Bash", input: { command: "ls -la" } }),
		);
		expect(lines()[0]).toBe("[08:09:10] tool_use Bash: ls -la");
	});

	test("renders-tool-result-error", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(event("tool_result", { is_error: true, content: "boom" }));
		expect(lines()[0]).toBe("[08:09:10] tool_result (error): boom");
	});

	test("renders-tool-result-content-array", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(
			event("tool_result", { content: [{ type: "text", text: "ok done" }] }),
		);
		expect(lines()[0]).toBe("[08:09:10] tool_result: ok done");
	});

	test("renders-terminal-result-with-cost-and-duration", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(
			event("result", { subtype: "success", total_cost_usd: 0.1234, duration_ms: 4200 }),
		);
		expect(lines()[0]).toBe("[08:09:10] result: success cost=$0.1234 duration=4200ms");
	});

	test("truncates-long-values", () => {
		const { sink, lines } = capture();
		const long = "x".repeat(300);
		createPrettyRenderer(sink).event(event("text", { text: long }));
		const line = lines()[0] ?? "";
		expect(line).toContain("… (+60 chars)");
		expect(line.length).toBeLessThan(300);
	});

	test("collapses-whitespace-in-truncation", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(event("text", { text: "a\n\n  b\tc" }));
		expect(lines()[0]).toBe("[08:09:10] assistant: a b c");
	});

	test("renders-lifecycle-dispatched", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(
			event("plan_run.dispatched", { planRunId: "pr-1", seq: 2, seedId: "wn-2" }),
		);
		expect(lines()[0]).toBe("[08:09:10] → dispatched child #2 wn-2");
	});

	test("renders-lifecycle-advanced", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(
			event("plan_run.advanced", { mergedChildSeq: 1, dispatchedChildSeq: 2 }),
		);
		expect(lines()[0]).toBe("[08:09:10] → advanced: merged child #1, dispatched child #2");
	});

	test("renders-lifecycle-waiting-for-merge", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(event("plan_run.waiting_for_merge", { seq: 3 }));
		expect(lines()[0]).toBe("[08:09:10] ⋯ waiting for merge of child #3");
	});

	test("renders-lifecycle-merged", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(event("plan_run.merged", { mergedChildSeq: 1 }));
		expect(lines()[0]).toBe("[08:09:10] ✔ merged child #1");
	});

	test("renders-lifecycle-failed-with-reason", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(
			event("plan_run.failed", { failedSeq: 2, reason: "child_pr_merge_timeout" }),
		);
		expect(lines()[0]).toBe("[08:09:10] ✗ child #2 failed: child_pr_merge_timeout");
	});

	test("renders-unknown-kind-generically", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(event("custom", { foo: 1 }, { stream: "system" }));
		expect(lines()[0]).toBe('[08:09:10] system custom: {"foo":1}');
	});

	test("invalid-timestamp-falls-back", () => {
		const { sink, lines } = capture();
		createPrettyRenderer(sink).event(event("text", { text: "hi" }, { ts: "not-a-date" }));
		expect(lines()[0]).toBe("[--:--:--] assistant: hi");
	});

	test("terminal-glyphs-by-state", () => {
		const { sink, lines } = capture();
		const r = createPrettyRenderer(sink);
		r.terminal("pr-1", "succeeded");
		r.terminal("pr-2", "failed");
		r.terminal("pr-3", "cancelled");
		expect(lines()).toEqual([
			"✔ plan-run pr-1 succeeded",
			"✗ plan-run pr-2 failed",
			"■ plan-run pr-3 cancelled",
		]);
	});

	test("cancelled-with-in-flight-child", () => {
		const { sink, lines } = capture();
		const res: CancelPlanRunResponse = {
			planRun: planRunRow({ state: "cancelled" }),
			cancelledChild: { childSeq: 2, runId: "run-b" },
			alreadyTerminal: false,
		};
		createPrettyRenderer(sink).cancelled(res);
		expect(lines()[0]).toBe("■ plan-run pr-1 cancelled — cancelled child #2");
	});

	test("cancelled-already-terminal", () => {
		const { sink, lines } = capture();
		const res: CancelPlanRunResponse = {
			planRun: planRunRow({ state: "succeeded" }),
			cancelledChild: null,
			alreadyTerminal: true,
		};
		createPrettyRenderer(sink).cancelled(res);
		expect(lines()[0]).toBe("■ plan-run pr-1 already succeeded — nothing to cancel");
	});
});

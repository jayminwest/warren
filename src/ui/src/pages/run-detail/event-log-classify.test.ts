import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@/api/types.ts";
import { classifyEvent, countViews, filterLines, textOf, toolArgs } from "./event-log-classify.ts";

let nextSeq = 1;
function ev(kind: string, payload: unknown, stream: RunEvent["stream"] = "stdout"): RunEvent {
	const seq = nextSeq++;
	return { id: seq, runId: "run_x", seq, ts: "2026-09-25T10:00:00Z", kind, stream, payload };
}

describe("classifyEvent", () => {
	test("agent text is a message line", () => {
		const l = classifyEvent(ev("text", { text: "Reading the files." }));
		expect(l.kind).toBe("message");
		expect(l.body).toBe("Reading the files.");
	});

	test("a text envelope with no prose falls back to noise", () => {
		expect(classifyEvent(ev("text", { type: "system", subtype: "init" })).kind).toBe("noise");
	});

	test("thinking reads the text field", () => {
		const l = classifyEvent(ev("thinking", { text: "Plan the change" }));
		expect(l.kind).toBe("thinking");
		expect(l.body).toBe("Plan the change");
	});

	test("pi tool calls show the tool name and its command", () => {
		const l = classifyEvent(
			ev("tool_use", { name: "bash", type: "toolCall", arguments: { command: "bun test" } }),
		);
		expect(l.kind).toBe("tool");
		expect(l.tool).toBe("bash");
		expect(l.body).toBe("bun test");
	});

	test("claude tool_use blocks read `input`", () => {
		const l = classifyEvent(
			ev("tool_use", { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }),
		);
		expect(l.title).toBe("Read");
		expect(l.body).toBe("src/a.ts");
	});

	test("tool results carry their text and error flag in both adapter shapes", () => {
		const pi = classifyEvent(
			ev("tool_result", { role: "toolResult", content: [{ text: "ok" }], isError: false }),
		);
		expect(pi.kind).toBe("result");
		expect(pi.body).toBe("ok");
		expect(pi.isError).toBe(false);
		const claude = classifyEvent(
			ev("tool_result", { type: "tool_result", content: "boom", is_error: true }),
		);
		expect(claude.isError).toBe(true);
		expect(claude.title).toBe("Tool error");
	});

	test("pi turn bookkeeping is noise; turn_end carries usage", () => {
		const start = classifyEvent(ev("state_change", { type: "turn_start" }, "system"));
		expect(start.kind).toBe("noise");
		const end = classifyEvent(
			ev(
				"state_change",
				{
					type: "turn_end",
					message: { usage: { input: 1407, output: 71, cost: { total: 0.0123 } } },
				},
				"system",
			),
		);
		expect(end.kind).toBe("noise");
		expect(end.body).toBe("1.4k in · 71 out · $0.012");
	});

	test("agent lifecycle envelopes are milestones", () => {
		expect(classifyEvent(ev("state_change", { type: "agent_start" }, "system")).title).toBe(
			"Agent started",
		);
		expect(classifyEvent(ev("agent_end", { reason: "done" }, "system")).kind).toBe("milestone");
		expect(classifyEvent(ev("state_change", { type: "compaction_end" }, "system")).title).toBe(
			"Context compacted",
		);
	});

	test("pi extension errors are error warnings", () => {
		const l = classifyEvent(
			ev("state_change", { type: "extension_error", message: "hook crashed" }, "system"),
		);
		expect(l.kind).toBe("warning");
		expect(l.isError).toBe(true);
	});

	test("reap facts are milestones with the summary knowledge kept", () => {
		const pushed = classifyEvent(
			ev("reap.branch_pushed", { branch: "warren/run_x", commitsAhead: 3 }, "system"),
		);
		expect(pushed.kind).toBe("milestone");
		expect(pushed.body).toBe("warren/run_x · 3 commits ahead");
		const done = classifyEvent(
			ev("reap.completed", { state: "succeeded", branchPushed: true, commitsAhead: 2 }, "system"),
		);
		expect(done.title).toBe("Run finalized");
		expect(done.body).toBe("succeeded · pushed (+2)");
		const closed = classifyEvent(ev("seeds.seed_id_closed", { id: "warren-1db0" }, "system"));
		expect(closed.body).toBe("warren-1db0");
	});

	test("reap problems and platform warnings are warnings", () => {
		const rejected = classifyEvent(
			ev("reap.push_rejected", { unblockUrls: ["https://x/unblock"], locations: [1] }, "system"),
		);
		expect(rejected.kind).toBe("warning");
		expect(rejected.body).toContain("unblock: https://x/unblock");
		const failed = classifyEvent(ev("reap_failed", { step: "push", message: "denied" }, "system"));
		expect(failed.isError).toBe(true);
		expect(failed.body).toBe("push: denied");
		const pod = classifyEvent(
			ev("k8s.pod_warning", { reason: "FailedScheduling", message: "0/3 nodes" }, "system"),
		);
		expect(pod.title).toBe("Pod warning");
		expect(pod.body).toBe("0/3 nodes");
		expect(classifyEvent(ev("anything", "oops", "stderr")).kind).toBe("warning");
	});

	test("steering messages carry the operator's body", () => {
		const l = classifyEvent(ev("steer.sent", { body: "Use the helper" }, "system"));
		expect(l.kind).toBe("steer");
		expect(l.body).toBe("Use the helper");
		expect(classifyEvent(ev("steer.delivered", { messageId: "m1" }, "system")).kind).toBe(
			"milestone",
		);
	});

	test("tool execution echoes and unknown kinds are noise", () => {
		expect(classifyEvent(ev("tool_execution_start", { name: "bash" }, "system")).kind).toBe(
			"noise",
		);
		expect(classifyEvent(ev("mystery", { a: 1 }, "system")).kind).toBe("noise");
	});

	test("caches per event object", () => {
		const e = ev("text", { text: "hi" });
		expect(classifyEvent(e)).toBe(classifyEvent(e));
	});
});

describe("filterLines / countViews", () => {
	const lines = [
		ev("text", { text: "Hello there" }),
		ev("tool_use", { name: "bash", arguments: { command: "ls" } }),
		ev("tool_result", { content: "a.ts", isError: true }),
		ev("state_change", { type: "turn_start" }, "system"),
		ev("reap.completed", { state: "failed" }, "system"),
		ev("k8s.pod_warning", { message: "evicted" }, "system"),
	].map(classifyEvent);

	test("activity hides noise; all shows it", () => {
		expect(filterLines(lines, "activity", "").length).toBe(5);
		expect(filterLines(lines, "all", "").length).toBe(6);
	});

	test("tools, conversation and problems pick their kinds", () => {
		expect(filterLines(lines, "tools", "").map((l) => l.kind)).toEqual([
			"tool",
			"result",
			"warning",
		]);
		expect(filterLines(lines, "conversation", "").map((l) => l.kind)).toEqual([
			"message",
			"milestone",
			"warning",
		]);
		expect(filterLines(lines, "problems", "").map((l) => l.kind)).toEqual(["result", "warning"]);
	});

	test("the query matches title, body, or kind case-insensitively", () => {
		expect(filterLines(lines, "all", "HELLO").length).toBe(1);
		expect(filterLines(lines, "all", "pod_warning").length).toBe(1);
		expect(filterLines(lines, "all", "  ").length).toBe(6);
	});

	test("countViews tallies messages, tool calls, and problems", () => {
		expect(countViews(lines)).toEqual({ conversation: 1, tools: 1, problems: 2 });
	});
});

describe("textOf / toolArgs", () => {
	test("textOf joins content parts and reads {text}", () => {
		expect(textOf([{ text: "a" }, "b", { other: 1 }])).toBe("a\nb");
		expect(textOf({ text: "c" })).toBe("c");
		expect(textOf(42)).toBe("");
	});

	test("toolArgs prefers the command, path, or pattern and falls back to JSON", () => {
		expect(toolArgs({ pattern: "needle" })).toBe("needle");
		expect(toolArgs({ x: 1 })).toBe('{"x":1}');
		expect(toolArgs({})).toBe("");
		expect(toolArgs("raw")).toBe("raw");
	});
});

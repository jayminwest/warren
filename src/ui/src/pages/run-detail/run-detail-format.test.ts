import { describe, expect, test } from "bun:test";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { deriveStageDurations, formatRunElapsed } from "./run-detail-format.ts";

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: "run_test",
		state: "succeeded",
		createdAt: Date.parse("2026-09-03T10:00:00Z"),
		startedAt: "2026-09-03T10:00:20Z",
		endedAt: "2026-09-03T10:20:00Z",
		workspaceReadyAt: "2026-09-03T10:00:40Z",
		agentReadyAt: "2026-09-03T10:01:00Z",
		agentEndedAt: "2026-09-03T10:15:00Z",
		reapedAt: "2026-09-03T10:19:00Z",
		...overrides,
	} as unknown as RunRow;
}

function makeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 1,
		runId: "run_test",
		seq: 1,
		ts: "2026-09-03T10:19:40Z",
		kind: "reap.pr_opened",
		stream: "system",
		payload: null,
		...overrides,
	};
}

describe("deriveStageDurations", () => {
	test("segments tile the run: sum(segments) === totalMs", () => {
		const run = makeRun();
		const events = [makeEvent()];
		const s = deriveStageDurations(run, events);
		const segments = [s.queuePrepMs, s.agentBootMs, s.agentRunMs, s.reapMs, s.deliveryMs];
		expect(segments.every((v) => v !== null)).toBe(true);
		expect(s.totalMs).not.toBeNull();
		const sum = segments.reduce((acc, v) => acc + (v ?? 0), 0);
		expect(sum).toBe(s.totalMs);
		// Spot-check the edges the spec pins.
		expect(s.queuePrepMs).toBe(40_000); // created -> workspace_ready
		expect(s.agentBootMs).toBe(20_000); // workspace_ready -> agent_ready
		expect(s.agentRunMs).toBe(14 * 60_000); // agent_ready -> agent_ended
		expect(s.reapMs).toBe(4 * 60_000); // agent_ended -> reaped
		expect(s.deliveryMs).toBe(40_000); // reaped -> reap.pr_opened event
	});

	test("totalMs falls back to ended_at when no pr_opened event exists", () => {
		const run = makeRun();
		const s = deriveStageDurations(run, []);
		expect(s.deliveryMs).toBe(60_000); // reaped_at -> ended_at
		expect(s.totalMs).toBe(Date.parse(run.endedAt as string) - (run.createdAt as number));
	});

	test("warren-935a: legacy row without the stage columns falls back to the event stream", () => {
		// Rows written before warren-7116 carry null on all four columns;
		// agent-start signals and reap events stand in for the edges.
		const run = makeRun({
			startedAt: "2026-09-03T10:00:40Z",
			endedAt: "2026-09-03T10:18:00Z",
			workspaceReadyAt: null,
			agentReadyAt: null,
			agentEndedAt: null,
			reapedAt: null,
		});
		const events = [
			makeEvent({ seq: 1, ts: "2026-09-03T10:00:40Z", kind: "agent_start", payload: null }),
			makeEvent({ seq: 2, ts: "2026-09-03T10:18:00Z", kind: "reap.completed" }),
			makeEvent({ seq: 3, ts: "2026-09-03T10:19:40Z", kind: "reap.pr_opened" }),
		];
		const s = deriveStageDurations(run, events);
		const segments = [s.queuePrepMs, s.agentBootMs, s.agentRunMs, s.reapMs, s.deliveryMs];
		expect(segments.every((v) => v !== null)).toBe(true);
		const sum = segments.reduce((acc, v) => acc + (v ?? 0), 0);
		expect(sum).toBe(s.totalMs);
		// Fallbacks: workspace_ready from the agent_start event, agent ready
		// from startedAt, reaped from the reap.completed event.
		expect(s.queuePrepMs).toBe(40_000);
		expect(s.agentBootMs).toBe(0);
		expect(s.agentRunMs).toBe(
			Date.parse("2026-09-03T10:18:00Z") - Date.parse("2026-09-03T10:00:40Z"),
		);
		expect(s.reapMs).toBe(0);
		expect(s.deliveryMs).toBe(100_000);
	});

	test("legacy row without any signal leaves unobservable segments null", () => {
		const run = makeRun({
			startedAt: null,
			endedAt: "2026-09-03T10:20:00Z",
			workspaceReadyAt: null,
			agentReadyAt: null,
			agentEndedAt: null,
			reapedAt: null,
		});
		const s = deriveStageDurations(run, []);
		expect(s.queuePrepMs).toBeNull();
		expect(s.agentBootMs).toBeNull();
		expect(s.agentRunMs).toBeNull();
		expect(s.reapMs).toBeNull();
		expect(s.totalMs).not.toBeNull(); // created -> ended_at still observable
	});

	test("formatRunElapsed reads created -> ended", () => {
		const run = makeRun();
		expect(formatRunElapsed(run, Date.now())).toBe("20:00");
	});
});

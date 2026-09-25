import { describe, expect, test } from "bun:test";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { connectorSpan, deriveStages, type Stage } from "./stage-timeline-logic.ts";

/** Minimal RunRow shaped to what deriveStages reads; the rest is unused. */
function makeRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: "run_test",
		state: "running",
		failureReason: null,
		createdAt: Date.parse("2026-09-03T10:00:00Z"),
		startedAt: null,
		endedAt: null,
		workspaceReadyAt: null,
		agentReadyAt: null,
		agentEndedAt: null,
		reapedAt: null,
		commitsAhead: null,
		prUrl: null,
		prState: null,
		prMergedAt: null,
		...overrides,
	} as unknown as RunRow;
}

function makeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 1,
		runId: "run_test",
		seq: 1,
		ts: "2026-09-03T10:01:00Z",
		kind: "state_change",
		stream: "system",
		payload: null,
		...overrides,
	};
}

function stage(stages: Stage[], key: string): Stage {
	const s = stages.find((x) => x.key === key);
	if (!s) throw new Error(`missing stage ${key}`);
	return s;
}

const statuses = (stages: Stage[]) => stages.map((s) => s.status);

describe("deriveStages workspace probe (warren-57fb)", () => {
	test("lights from run.startedAt while the run is live", () => {
		const run = makeRun({ startedAt: "2026-09-03T10:00:30Z" });
		expect(stage(deriveStages(run, []), "workspace").status).toBe("done");
	});

	test("probes the pi adapter's state_change payload.type form", () => {
		const events = [makeEvent({ payload: { type: "agent_start" }, ts: "2026-09-03T10:00:45Z" })];
		const ws = stage(deriveStages(makeRun(), events), "workspace");
		expect(ws.status).toBe("done");
		expect(ws.at).toBe(Date.parse("2026-09-03T10:00:45Z"));
	});

	test("is the live stage while running with no agent-start signal", () => {
		const stages = deriveStages(makeRun(), []);
		expect(statuses(stages)).toEqual(["done", "live", "pending", "pending", "pending", "pending"]);
	});

	test("does not fill from the terminal state alone", () => {
		const run = makeRun({
			state: "failed",
			failureReason: "never_started",
			endedAt: "2026-09-03T10:05:00Z",
		});
		const stages = deriveStages(run, []);
		expect(stage(stages, "workspace").status).toBe("failed");
		expect(stage(stages, "workspace").note).toBe("Never started");
		expect(stage(stages, "agent-end").status).toBe("skipped");
	});
});

describe("deriveStages lifecycle", () => {
	const full = {
		startedAt: "2026-09-03T10:01:10Z",
		workspaceReadyAt: "2026-09-03T10:01:00Z",
		agentReadyAt: "2026-09-03T10:01:10Z",
		agentEndedAt: "2026-09-03T10:20:00Z",
		reapedAt: "2026-09-03T10:21:00Z",
		endedAt: "2026-09-03T10:21:00Z",
	};

	test("a delivered PR run is done end to end", () => {
		const run = makeRun({
			...full,
			state: "succeeded",
			prUrl: "https://github.com/o/r/pull/7",
			prState: "open",
		});
		const events = [makeEvent({ kind: "reap.pr_opened", ts: "2026-09-03T10:21:05Z" })];
		const stages = deriveStages(run, events);
		expect(statuses(stages).every((s) => s === "done")).toBe(true);
		expect(stage(stages, "delivery").label).toBe("PR opened");
		expect(stage(stages, "delivery").at).toBe(Date.parse("2026-09-03T10:21:05Z"));
	});

	test("a merged PR places delivery at the merge instant", () => {
		const run = makeRun({
			...full,
			state: "succeeded",
			prUrl: "https://github.com/o/r/pull/7",
			prState: "merged",
			prMergedAt: "2026-09-03T11:00:00Z",
		});
		const d = stage(deriveStages(run, []), "delivery");
		expect(d.label).toBe("Merged");
		expect(d.at).toBe(Date.parse("2026-09-03T11:00:00Z"));
	});

	test("commits without a PR read as a pushed branch", () => {
		const run = makeRun({ ...full, state: "succeeded", commitsAhead: 2 });
		expect(stage(deriveStages(run, []), "delivery").label).toBe("Branch pushed");
	});

	test("a failed reap-time run fails on the delivery node", () => {
		const run = makeRun({ ...full, state: "failed", failureReason: "dropped_commit" });
		const d = stage(deriveStages(run, []), "delivery");
		expect(d.status).toBe("failed");
		expect(d.note).toBe("Dropped commit");
	});

	test("a succeeded run with nothing to deliver skips delivery", () => {
		const run = makeRun({ ...full, state: "succeeded", commitsAhead: 0 });
		const d = stage(deriveStages(run, []), "delivery");
		expect(d.status).toBe("skipped");
		expect(d.note).toBe("Nothing delivered");
	});

	test("reap is not short-circuited by the terminal state (warren-57fb)", () => {
		const run = makeRun({
			state: "failed",
			failureReason: "finalize_failed",
			startedAt: "2026-09-03T10:01:10Z",
			endedAt: "2026-09-03T10:05:00Z",
		});
		const stages = deriveStages(run, []);
		expect(stage(stages, "agent-end").status).toBe("done");
		expect(stage(stages, "reap").status).toBe("failed");
	});

	test("reap lights from the reap.completed event on legacy rows", () => {
		const run = makeRun({ state: "succeeded", startedAt: "2026-09-03T10:01:10Z" });
		const events = [makeEvent({ kind: "reap.completed", ts: "2026-09-03T10:05:30Z" })];
		expect(stage(deriveStages(run, events), "reap").status).toBe("done");
	});

	test("an unreported middle stage is skipped, not a gap", () => {
		const run = makeRun({
			state: "running",
			workspaceReadyAt: null,
			agentReadyAt: "2026-09-03T10:01:10Z",
			startedAt: null,
		});
		const stages = deriveStages(run, []);
		expect(stage(stages, "workspace").status).toBe("skipped");
		expect(stage(stages, "agent-end").status).toBe("live");
	});
});

describe("connectorSpan", () => {
	test("spans observed neighbours and ticks toward a live stage", () => {
		const run = makeRun({
			workspaceReadyAt: "2026-09-03T10:01:00Z",
			agentReadyAt: "2026-09-03T10:01:10Z",
		});
		const stages = deriveStages(run, []);
		expect(connectorSpan(stages, 0, 0)).toEqual({ ms: 60_000, live: false });
		const now = Date.parse("2026-09-03T10:03:10Z");
		expect(connectorSpan(stages, 2, now)).toEqual({ ms: 120_000, live: true });
		expect(connectorSpan(stages, 3, now)).toEqual({ ms: null, live: false });
		expect(connectorSpan(stages, 5, now)).toEqual({ ms: null, live: false });
	});
});

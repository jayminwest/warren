import { describe, expect, test } from "bun:test";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { cellClass, derivePhases, dotClass } from "./phase-rail-logic.ts";

/** Minimal RunRow shaped to what derivePhases reads; the rest is unused. */
function makeRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: "run_test",
		state: "running",
		createdAt: "2026-09-03T10:00:00Z",
		startedAt: null,
		endedAt: null,
		commitsAhead: null,
		prUrl: null,
		prState: null,
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

function phase(rail: ReturnType<typeof derivePhases>, label: string) {
	const cell = rail.find((c) => c.label === label);
	if (!cell) throw new Error(`missing phase ${label}`);
	return cell;
}

describe("derivePhases workspace probe", () => {
	test("warren-57fb: lights from run.startedAt while the run is live", () => {
		const run = makeRun({ state: "running", startedAt: "2026-09-03T10:00:30Z" });
		const cell = phase(derivePhases(run, []), "Workspace ready");
		expect(cell.state).toBe("done");
		expect(cell.sub).not.toBe("pending");
	});

	test("warren-57fb: probes the pi adapter's state_change payload.type form", () => {
		// The pi adapter maps the harness's `agent_start` envelope to
		// state_change on system with the raw type in payload.type.
		const run = makeRun({ state: "running", startedAt: null });
		const events = [makeEvent({ payload: { type: "agent_start" }, ts: "2026-09-03T10:00:45Z" })];
		const cell = phase(derivePhases(run, events), "Workspace ready");
		expect(cell.state).toBe("done");
		expect(cell.sub).toContain("10:00");
	});

	test("stays pending while live with no agent-start signal", () => {
		const run = makeRun({ state: "running", startedAt: null });
		const cell = phase(derivePhases(run, []), "Workspace ready");
		expect(cell.state).toBe("pending");
		expect(cell.sub).toBe("pending");
	});

	test("no longer fills from the terminal state alone", () => {
		// A terminal row without any agent-start signal has not reported a
		// workspace ready point; the old code short-circuited on terminal.
		const run = makeRun({ state: "succeeded", startedAt: null, endedAt: "2026-09-03T10:05:00Z" });
		const cell = phase(derivePhases(run, []), "Workspace ready");
		expect(cell.state).toBe("pending");
	});
});

describe("phase rail presentation helpers", () => {
	test("dotClass covers all three phase states", () => {
		expect(dotClass("done")).toBe("bg-(--color-success)");
		expect(dotClass("active")).toBe("bg-(--color-info)");
		expect(dotClass("pending")).toBe("bg-(--color-neutral)");
	});

	test("cellClass highlights only the active cell", () => {
		expect(cellClass("active")).toContain("bg-(--color-primary)/5");
		expect(cellClass("done")).toBe("border-b border-transparent");
	});
});

describe("derivePhases branch coverage", () => {
	test("git delivery renders commit count and empty-push fallbacks", () => {
		const events = [makeEvent({ kind: "reap.completed", ts: "2026-09-03T10:05:30Z" })];
		const pushed = phase(
			derivePhases(
				makeRun({ state: "succeeded", commitsAhead: 2, endedAt: "2026-09-03T10:05:00Z" }),
				events,
			),
			"Git delivery",
		);
		expect(pushed.state).toBe("done");
		expect(pushed.sub).toBe("+2 commits pushed");
		const pushedOne = phase(
			derivePhases(
				makeRun({ state: "succeeded", commitsAhead: 1, endedAt: "2026-09-03T10:05:00Z" }),
				events,
			),
			"Git delivery",
		);
		expect(pushedOne.sub).toBe("+1 commit pushed");
		const empty = phase(
			derivePhases(
				makeRun({ state: "failed", commitsAhead: 0, endedAt: "2026-09-03T10:05:00Z" }),
				events,
			),
			"Git delivery",
		);
		expect(empty.sub).toBe("no new commits");
	});

	test("agent running sub-line falls back to 'running' without an elapsed start", () => {
		const run = makeRun({ state: "running", startedAt: null, createdAt: null });
		const cell = phase(derivePhases(run, []), "Agent running");
		expect(cell.state).toBe("active");
		expect(cell.sub).toBe("running");
	});

	test("agent running shows elapsed time from startedAt", () => {
		const run = makeRun({ state: "running", startedAt: "2026-09-03T10:00:30Z" });
		const cell = phase(derivePhases(run, []), "Agent running");
		expect(cell.sub.endsWith("elapsed")).toBe(true);
	});

	test("queued run keeps the agent phase pending", () => {
		const run = makeRun({ state: "queued", startedAt: null });
		const cell = phase(derivePhases(run, []), "Agent running");
		expect(cell.state).toBe("pending");
		expect(cell.sub).toBe("pending");
	});
});

describe("derivePhases reap phase", () => {
	test("warren-57fb: does not short-circuit on terminal state", () => {
		// finalize_failed rows are terminal but never reaped.
		const run = makeRun({
			state: "failed",
			endedAt: "2026-09-03T10:05:00Z",
			commitsAhead: 0,
		});
		const cell = phase(derivePhases(run, []), "Reap");
		expect(cell.state).toBe("pending");
	});

	test("lights on the reap.completed event", () => {
		const run = makeRun({ state: "succeeded", endedAt: "2026-09-03T10:05:00Z" });
		const events = [makeEvent({ kind: "reap.completed", ts: "2026-09-03T10:05:30Z" })];
		const cell = phase(derivePhases(run, events), "Reap");
		expect(cell.state).toBe("done");
	});
});

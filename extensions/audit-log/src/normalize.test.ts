import { describe, expect, test } from "bun:test";
import {
	ACTOR_KIND_UNKNOWN,
	type AuditFact,
	factsFromEvent,
	factsFromRun,
} from "./normalize.ts";
import type { RunEvent, RunListRow } from "./wire.ts";

function event(kind: string, payload: unknown, over: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 1,
		runId: "run-1",
		seq: 7,
		ts: "2026-08-04T10:00:00Z",
		kind,
		stream: "system",
		payload,
		...over,
	};
}

const BOTH = { includeDispatched: true, includeStarted: true };
const NEITHER = { includeDispatched: false, includeStarted: false };

function types(facts: readonly AuditFact[]): string[] {
	return facts.map((f) => f.event);
}

describe("factsFromEvent", () => {
	test("synthesizes run.dispatched and run.started on first observation", () => {
		const facts = factsFromEvent(event("message", { n: 1 }, { seq: 3 }), BOTH);
		expect(types(facts)).toEqual(["run.dispatched", "run.started"]);
		expect(facts[0]?.at).toBe("2026-08-04T10:00:00Z");
		expect(facts[0]?.sourceSeq).toBeNull();
		expect(facts[1]?.sourceSeq).toBe(3);
		expect(facts[0]?.actorKind).toBe(ACTOR_KIND_UNKNOWN);
	});

	test("skips synthesis the store says is already recorded", () => {
		expect(factsFromEvent(event("message", {}), NEITHER)).toEqual([]);
	});

	test("maps steer.sent to run.steered with the steer detail", () => {
		const facts = factsFromEvent(
			event("steer.sent", {
				messageId: "m-1",
				priority: "normal",
				fromActor: "operator",
				body: "please also run the tests",
			}),
			NEITHER,
		);
		expect(types(facts)).toEqual(["run.steered"]);
		expect(facts[0]?.detail).toEqual({
			messageId: "m-1",
			priority: "normal",
			fromActor: "operator",
			body: "please also run the tests",
		});
		expect(facts[0]?.sourceSeq).toBe(7);
	});

	test("maps reap.pr_opened to pr.opened with the PR detail", () => {
		const facts = factsFromEvent(
			event("reap.pr_opened", {
				prUrl: "https://github.com/x/y/pull/1",
				mode: "created",
				branch: "warren/run-1",
				baseBranch: "main",
			}),
			NEITHER,
		);
		expect(types(facts)).toEqual(["pr.opened"]);
		expect(facts[0]?.detail).toEqual({
			prUrl: "https://github.com/x/y/pull/1",
			mode: "created",
			branch: "warren/run-1",
			baseBranch: "main",
		});
	});

	test("maps reap.completed with branchPushed to branch.pushed and run.terminal", () => {
		const facts = factsFromEvent(
			event("reap.completed", { state: "succeeded", branchPushed: true, commitsAhead: 2 }),
			NEITHER,
		);
		expect(types(facts)).toEqual(["run.terminal", "branch.pushed"]);
		expect(facts[0]?.detail).toEqual({ state: "succeeded", source: "reap.completed" });
		expect(facts[0]?.sourceSeq).toBeNull();
		expect(facts[1]?.detail).toEqual({ commitsAhead: 2, state: "succeeded" });
		expect(facts[1]?.sourceSeq).toBe(7);
	});

	test("maps reap.completed without a push to run.terminal only", () => {
		const facts = factsFromEvent(
			event("reap.completed", { state: "failed", branchPushed: false }),
			NEITHER,
		);
		expect(types(facts)).toEqual(["run.terminal"]);
	});

	test("ignores unknown kinds and malformed payloads", () => {
		expect(factsFromEvent(event("tool_use", { name: "bash" }), NEITHER)).toEqual([]);
		expect(factsFromEvent(event("steer.sent", null), NEITHER)).toEqual([
			expect.objectContaining({ event: "run.steered", detail: null }),
		]);
		expect(factsFromEvent(event("reap.completed", "not-an-object"), NEITHER)).toEqual([]);
	});
});

describe("factsFromRun", () => {
	const now = new Date("2026-08-04T12:00:00Z");

	test("candidates run.dispatched for a live run", () => {
		const run: RunListRow = { id: "run-1", state: "running" };
		const facts = factsFromRun(run, now);
		expect(types(facts)).toEqual(["run.dispatched"]);
		expect(facts[0]?.at).toBe("2026-08-04T12:00:00.000Z");
	});

	test("candidates run.terminal for a terminal run", () => {
		const run: RunListRow = { id: "run-1", state: "succeeded" };
		const facts = factsFromRun(run, now);
		expect(types(facts)).toEqual(["run.dispatched", "run.terminal"]);
		expect(facts[1]?.detail).toEqual({ state: "succeeded", source: "run-list" });
	});
});

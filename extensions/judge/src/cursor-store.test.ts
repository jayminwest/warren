import { describe, expect, test } from "bun:test";
import { JudgmentCursorStore } from "./cursor-store.ts";

const RUBRIC_V1 = "sha256:" + "ab".repeat(32);
const RUBRIC_V2 = "sha256:" + "cd".repeat(32);
const MODEL = "claude-haiku-4-5";

function makeStore(): JudgmentCursorStore {
	return new JudgmentCursorStore(":memory:");
}

describe("JudgmentCursorStore", () => {
	test("returns null for a run never judged", () => {
		const store = makeStore();
		expect(store.get("run-1")).toBeNull();
		expect(store.needsJudgment("run-1", RUBRIC_V1, MODEL)).toBe(true);
		store.close();
	});

	test("checkpoint makes the run judged under the recorded pair", () => {
		const store = makeStore();
		store.checkpoint("run-1", {
			rubricVersion: RUBRIC_V1,
			judgeModelId: MODEL,
			outcome: "verdict",
			updatedAt: "2026-08-15T17:00:00.000Z",
		});
		const cursor = store.get("run-1");
		expect(cursor?.rubricVersion).toBe(RUBRIC_V1);
		expect(cursor?.judgeModelId).toBe(MODEL);
		expect(cursor?.outcome).toBe("verdict");
		expect(store.needsJudgment("run-1", RUBRIC_V1, MODEL)).toBe(false);
		expect(store.trackedRuns()).toBe(1);
		store.close();
	});

	test("a new rubric version or judge model re-opens the run", () => {
		const store = makeStore();
		store.checkpoint("run-1", {
			rubricVersion: RUBRIC_V1,
			judgeModelId: MODEL,
			outcome: "verdict",
			updatedAt: "2026-08-15T17:00:00.000Z",
		});
		expect(store.needsJudgment("run-1", RUBRIC_V2, MODEL)).toBe(true);
		expect(store.needsJudgment("run-1", RUBRIC_V1, "claude-opus-4-1")).toBe(true);
		store.close();
	});

	test("a re-checkpoint under a new pair overwrites the cursor", () => {
		const store = makeStore();
		store.checkpoint("run-1", {
			rubricVersion: RUBRIC_V1,
			judgeModelId: MODEL,
			outcome: "unjudged",
			updatedAt: "2026-08-15T17:00:00.000Z",
		});
		store.checkpoint("run-1", {
			rubricVersion: RUBRIC_V2,
			judgeModelId: MODEL,
			outcome: "verdict",
			updatedAt: "2026-08-16T09:00:00.000Z",
		});
		const cursor = store.get("run-1");
		expect(cursor?.rubricVersion).toBe(RUBRIC_V2);
		expect(cursor?.outcome).toBe("verdict");
		expect(cursor?.updatedAt).toBe("2026-08-16T09:00:00.000Z");
		expect(store.trackedRuns()).toBe(1);
		store.close();
	});
});

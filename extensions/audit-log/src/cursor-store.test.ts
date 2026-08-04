import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorStore } from "./cursor-store.ts";

describe("CursorStore", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tmpDbPath(): string {
		const dir = mkdtempSync(join(tmpdir(), "audit-log-cursors-"));
		dirs.push(dir);
		return join(dir, "cursors.db");
	}

	test("an unseen run has the zero cursor", () => {
		const store = new CursorStore(":memory:");
		expect(store.get("r1")).toEqual({
			runId: "r1",
			lastSeq: 0,
			runState: null,
			drained: false,
			updatedAt: "",
		});
		store.close();
	});

	test("checkpoint advances the cursor and marks drained", () => {
		const store = new CursorStore(":memory:");
		store.checkpoint("r1", 7, "running", false, "2026-08-04T00:00:00Z");
		expect(store.get("r1").lastSeq).toBe(7);
		expect(store.get("r1").drained).toBe(false);

		store.checkpoint("r1", 9, "succeeded", true, "2026-08-04T00:01:00Z");
		const cursor = store.get("r1");
		expect(cursor.lastSeq).toBe(9);
		expect(cursor.drained).toBe(true);
		expect(cursor.runState).toBe("succeeded");
		store.close();
	});

	test("checkpoints are monotonic — a stale writer cannot rewind", () => {
		const store = new CursorStore(":memory:");
		store.checkpoint("r1", 9, "succeeded", true, "2026-08-04T00:01:00Z");
		store.checkpoint("r1", 3, "running", false, "2026-08-04T00:02:00Z");
		expect(store.get("r1").lastSeq).toBe(9);
		expect(store.get("r1").drained).toBe(true);
		store.close();
	});

	test("cursors survive a close and reopen — durable resume", () => {
		const path = tmpDbPath();
		const first = new CursorStore(path);
		first.checkpoint("r1", 42, "running", false, "2026-08-04T00:00:00Z");
		first.checkpoint("r2", 5, "succeeded", true, "2026-08-04T00:00:00Z");
		first.close();

		const second = new CursorStore(path);
		expect(second.get("r1").lastSeq).toBe(42);
		expect(second.get("r2").drained).toBe(true);
		expect(second.trackedRuns()).toBe(2);
		second.close();
	});
});

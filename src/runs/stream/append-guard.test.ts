import { describe, expect, test } from "bun:test";
import type { AppendEventInput } from "../../db/repos/events.ts";
import type { EventRow } from "../../db/schema.ts";
import { appendOrDrop, MAX_CONSECUTIVE_APPEND_FAILURES, newAppendGuard } from "./append-guard.ts";

const input: AppendEventInput = {
	runId: "run_test",
	sandboxEventSeq: 1,
	ts: "2026-05-08T12:00:01.000Z",
	kind: "text",
	payload: { seq: 1 },
};

function events(plan: readonly boolean[]): { append: (i: AppendEventInput) => Promise<EventRow> } {
	let i = 0;
	return {
		append: async (_i) => {
			const ok = plan[i] ?? true;
			i += 1;
			if (!ok) throw new Error("unsupported Unicode escape sequence");
			return { id: i } as unknown as EventRow;
		},
	};
}

describe("appendOrDrop", () => {
	test("returns the row and resets the streak on success", async () => {
		const guard = newAppendGuard();
		guard.consecutiveFailures = 2;
		const row = await appendOrDrop(guard, events([true]), input);
		expect(row).not.toBeNull();
		expect(guard.consecutiveFailures).toBe(0);
	});

	test("drops an isolated failure and returns null", async () => {
		const guard = newAppendGuard();
		const logged: string[] = [];
		const logger = { error: (_o: unknown, msg?: string) => logged.push(msg ?? "") };
		const row = await appendOrDrop(guard, events([false]), input, logger);
		expect(row).toBeNull();
		expect(guard.consecutiveFailures).toBe(1);
		expect(logged).toEqual(["bridge dropped event after append failure"]);
	});

	test("rethrows once failures reach the consecutive ceiling", async () => {
		const guard = newAppendGuard();
		const repo = events(Array(MAX_CONSECUTIVE_APPEND_FAILURES).fill(false));
		for (let n = 1; n < MAX_CONSECUTIVE_APPEND_FAILURES; n += 1) {
			expect(await appendOrDrop(guard, repo, input)).toBeNull();
		}
		await expect(appendOrDrop(guard, repo, input)).rejects.toThrow("unsupported Unicode");
	});

	test("a success between failures keeps the streak from reaching the ceiling", async () => {
		const guard = newAppendGuard();
		const repo = events([false, false, true, false, false]);
		for (const _ of [1, 2]) expect(await appendOrDrop(guard, repo, input)).toBeNull();
		expect(await appendOrDrop(guard, repo, input)).not.toBeNull();
		for (const _ of [1, 2]) expect(await appendOrDrop(guard, repo, input)).toBeNull();
		expect(guard.consecutiveFailures).toBe(2);
	});
});

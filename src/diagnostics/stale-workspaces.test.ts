import { describe, expect, test } from "bun:test";
import type { RunRow, RunState } from "../db/schema.ts";
import { checkStaleBurrowWorkspaces } from "./stale-workspaces.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");

function terminalRun(burrowId: string, endedAt: string): RunRow {
	return { burrowId, endedAt, state: "succeeded" } as unknown as RunRow;
}

function activeRun(burrowId: string): RunRow {
	return { burrowId, endedAt: null, state: "running" } as unknown as RunRow;
}

/** Route a listByState mock: active states → active rows, else terminal rows. */
function probe(active: RunRow[], terminal: RunRow[]) {
	return {
		listByState: async (states: RunState[]) => (states.includes("running") ? active : terminal),
	};
}

describe("checkStaleBurrowWorkspaces", () => {
	test("ok when nothing is stranded", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: probe([], []),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("none stranded");
	});

	test("warns with a recovery hint when burrows are stranded", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: probe([], [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("1 stranded burrow workspace");
		expect(result.hint).toContain("workspace GC");
	});

	test("a recent terminal run keeps a burrow live", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: probe([], [terminalRun("bur_x", "2026-05-29T11:50:00.000Z")]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	test("an active run is never stranded", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: probe([activeRun("bur_live")], [terminalRun("bur_live", "2026-05-01T00:00:00.000Z")]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	test("fails loudly when the probe throws", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: {
				listByState: async () => {
					throw new Error("db down");
				},
			},
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe("db down");
	});
});

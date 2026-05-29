import { describe, expect, test } from "bun:test";
import type { BurrowRow, RunRow } from "../db/schema.ts";
import { checkStaleBurrowWorkspaces } from "./stale-workspaces.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");

function burrow(id: string, addedAt: string): BurrowRow {
	return { id, workerId: "local", addedAt };
}

function terminalRun(burrowId: string, endedAt: string): RunRow {
	return { burrowId, endedAt, state: "succeeded" } as unknown as RunRow;
}

describe("checkStaleBurrowWorkspaces", () => {
	test("ok when nothing is stranded", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: {
				listAll: async () => [burrow("bur_a", NOW.toISOString())],
				listByState: async () => [],
			},
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("none stranded");
	});

	test("warns with a recovery hint when burrows are stranded", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: {
				listAll: async () => [burrow("bur_old", "2026-05-29T09:00:00.000Z")],
				listByState: async () => [],
			},
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("1 stranded burrow workspace");
		expect(result.hint).toContain("workspace GC");
	});

	test("a recent terminal run keeps a long-lived burrow live", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: {
				listAll: async () => [burrow("bur_x", "2026-01-01T00:00:00.000Z")],
				listByState: async (states) =>
					states.includes("succeeded") ? [terminalRun("bur_x", "2026-05-29T11:50:00.000Z")] : [],
			},
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	test("an active run is never stranded", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: {
				listAll: async () => [burrow("bur_live", "2026-05-01T00:00:00.000Z")],
				listByState: async (states) =>
					states.includes("running")
						? [{ burrowId: "bur_live", state: "running" } as unknown as RunRow]
						: [],
			},
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	test("fails loudly when the probe throws", async () => {
		const result = await checkStaleBurrowWorkspaces({
			probe: {
				listAll: async () => {
					throw new Error("db down");
				},
				listByState: async () => [],
			},
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe("db down");
	});
});

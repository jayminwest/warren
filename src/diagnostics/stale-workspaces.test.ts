import { describe, expect, test } from "bun:test";
import type { RunRow, RunState } from "../db/schema.ts";
import { checkStaleSandboxWorkspaces } from "./stale-workspaces.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");

function terminalRun(sandboxId: string, endedAt: string): RunRow {
	return { sandboxId, endedAt, state: "succeeded" } as unknown as RunRow;
}

function activeRun(sandboxId: string): RunRow {
	return { sandboxId, endedAt: null, state: "running" } as unknown as RunRow;
}

/** Route a listByState mock: active states → active rows, else terminal rows. */
function probe(active: RunRow[], terminal: RunRow[]) {
	return {
		listByState: async (states: RunState[]) => (states.includes("running") ? active : terminal),
	};
}

describe("checkStaleSandboxWorkspaces", () => {
	test("ok when nothing is stranded", async () => {
		const result = await checkStaleSandboxWorkspaces({
			probe: probe([], []),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("none stranded");
	});

	test("warns with a recovery hint when burrows are stranded", async () => {
		const result = await checkStaleSandboxWorkspaces({
			probe: probe([], [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("1 stranded burrow workspace");
		expect(result.hint).toContain("workspace GC");
	});

	test("a recent terminal run keeps a burrow live", async () => {
		const result = await checkStaleSandboxWorkspaces({
			probe: probe([], [terminalRun("bur_x", "2026-05-29T11:50:00.000Z")]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	test("goes green once a stranded workspace's destruction is persisted (warren-9b77)", async () => {
		// Before the GC persists the outcome the burrow is reported stranded…
		const before = await checkStaleSandboxWorkspaces({
			probe: probe([], [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(before.ok).toBe(false);
		// …and once the sweep nulls sandboxId (the persisted destruction
		// marker) the same rows no longer strand anything.
		const cleared = { ...terminalRun("bur_old", "2026-05-29T09:00:00.000Z"), sandboxId: null };
		const after = await checkStaleSandboxWorkspaces({
			probe: probe([], [cleared]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(after.ok).toBe(true);
		expect(after.message).toContain("none stranded");
	});

	test("an active run is never stranded", async () => {
		const result = await checkStaleSandboxWorkspaces({
			probe: probe([activeRun("bur_live")], [terminalRun("bur_live", "2026-05-01T00:00:00.000Z")]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	test("fails with a reason code and logs the raw driver text (warren-51de)", async () => {
		const logged: object[] = [];
		const result = await checkStaleSandboxWorkspaces({
			probe: {
				listByState: async () => {
					throw new Error("connection to server at 10.0.0.4 port 5432 failed: ECONNREFUSED");
				},
			},
			ttlMs: 60 * 60_000,
			now: NOW,
			log: { warn: (obj) => logged.push(obj) },
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe("probe failed (reason=unreachable)");
		expect(result.message).not.toContain("5432");
		expect(logged[0]).toMatchObject({
			check: "stale_sandbox_workspaces",
			reason: "unreachable",
		});
	});
});

import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { RunRow } from "../../db/schema.ts";
import {
	buildBurrowActivity,
	DEFAULT_WORKSPACE_GC_TICK_MS,
	DEFAULT_WORKSPACE_GC_TTL_MS,
	findStrandedBurrows,
	loadWorkspaceGcConfigFromEnv,
	runWorkspaceGcTick,
	startWorkspaceGcWorker,
	type WorkspaceDestroyOutcome,
	type WorkspaceGcConfig,
	type WorkspaceGcTickInput,
} from "./gc.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");

/** A terminal run row that anchors a burrow id at a given endedAt. */
function terminalRun(burrowId: string, endedAt: string): RunRow {
	return { burrowId, endedAt, state: "succeeded" } as unknown as RunRow;
}

function activeRun(burrowId: string): RunRow {
	return { burrowId, endedAt: null, state: "running" } as unknown as RunRow;
}

function destroyedOutcome(): WorkspaceDestroyOutcome {
	return { status: "destroyed", archived: true, deletedEvents: 3, deletedRuns: 2 };
}

describe("findStrandedBurrows", () => {
	test("flags burrows whose newest terminal run is older than the ttl", () => {
		const out = findStrandedBurrows({
			activeBurrowIds: new Set(),
			latestEndedAt: new Map([["bur_old", "2026-05-29T10:00:00.000Z"]]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out.map((s) => s.burrowId)).toEqual(["bur_old"]);
		expect(out[0]?.ageMs).toBe(2 * 60 * 60_000);
	});

	test("skips burrows with a live run", () => {
		const out = findStrandedBurrows({
			activeBurrowIds: new Set(["bur_live"]),
			latestEndedAt: new Map([["bur_live", "2026-05-01T00:00:00.000Z"]]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out).toEqual([]);
	});

	test("skips burrows whose latest run ended within the ttl", () => {
		const out = findStrandedBurrows({
			activeBurrowIds: new Set(),
			latestEndedAt: new Map([["bur_recent", "2026-05-29T11:30:00.000Z"]]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out).toEqual([]);
	});

	test("sorts oldest-first", () => {
		const out = findStrandedBurrows({
			activeBurrowIds: new Set(),
			latestEndedAt: new Map([
				["bur_a", "2026-05-29T10:00:00.000Z"],
				["bur_b", "2026-05-29T06:00:00.000Z"],
			]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out.map((s) => s.burrowId)).toEqual(["bur_b", "bur_a"]);
	});

	test("skips rows with an unparseable timestamp", () => {
		const out = findStrandedBurrows({
			activeBurrowIds: new Set(),
			latestEndedAt: new Map([["bur_bad", "not-a-date"]]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out).toEqual([]);
	});
});

describe("buildBurrowActivity", () => {
	test("collects active burrow ids and the newest terminal endedAt", () => {
		const active = buildBurrowActivity(
			[{ burrowId: "bur_live", state: "running" } as unknown as RunRow],
			[
				{ burrowId: "bur_x", endedAt: "2026-05-01T00:00:00.000Z" } as unknown as RunRow,
				{ burrowId: "bur_x", endedAt: "2026-05-02T00:00:00.000Z" } as unknown as RunRow,
				{ burrowId: null, endedAt: "2026-05-03T00:00:00.000Z" } as unknown as RunRow,
			],
		);
		expect([...active.activeBurrowIds]).toEqual(["bur_live"]);
		expect(active.latestEndedAt.get("bur_x")).toBe("2026-05-02T00:00:00.000Z");
	});
});

interface Harness {
	activeRuns: RunRow[];
	terminalRuns: RunRow[];
	destroyed: string[];
}

function tickInput(
	h: Harness,
	over: Partial<WorkspaceGcTickInput> = {},
	config: Partial<WorkspaceGcConfig> = {},
): WorkspaceGcTickInput {
	return {
		repos: {
			runs: {
				listByState: async (states) => (states.includes("running") ? h.activeRuns : h.terminalRuns),
			},
		},
		config: { ttlMs: 60 * 60_000, tickMs: 1000, disabled: false, ...config },
		now: () => NOW,
		destroyWorkspace: async (sandboxId) => {
			h.destroyed.push(sandboxId);
			return destroyedOutcome();
		},
		...over,
	};
}

describe("runWorkspaceGcTick", () => {
	test("destroys stranded burrows", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
		};
		const result = await runWorkspaceGcTick(tickInput(h));
		expect(result).toEqual({ scanned: 1, stranded: 1, destroyed: 1, failed: 0 });
		expect(h.destroyed).toEqual(["bur_old"]);
	});

	test("never touches a burrow with a live run", async () => {
		const h: Harness = {
			activeRuns: [activeRun("bur_live")],
			terminalRuns: [terminalRun("bur_live", "2026-05-29T00:00:00.000Z")],
			destroyed: [],
		};
		const result = await runWorkspaceGcTick(tickInput(h));
		expect(result.scanned).toBe(0);
		expect(result.destroyed).toBe(0);
		expect(h.destroyed).toEqual([]);
	});

	test("counts a destroy failure", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
		};
		const result = await runWorkspaceGcTick(
			tickInput(h, {
				destroyWorkspace: async () => ({ status: "failed", error: "worker unreachable" }),
			}),
		);
		expect(result).toEqual({ scanned: 1, stranded: 1, destroyed: 0, failed: 1 });
	});

	test("treats a 404 from burrow as already-gone: counts as destroyed", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
		};
		const logs: string[] = [];
		const result = await runWorkspaceGcTick(
			tickInput(h, {
				destroyWorkspace: async () => ({ status: "already-gone" }),
				logger: {
					info: (obj) => {
						logs.push((obj as { msg?: string }).msg ?? JSON.stringify(obj));
					},
					warn: () => {},
					error: () => {},
				},
			}),
		);
		// Counts as destroyed (not failed) so the metric stays accurate.
		expect(result).toEqual({ scanned: 1, stranded: 1, destroyed: 1, failed: 0 });
		// Logged at info, not warn — it's not an error.
		expect(logs.some((m) => m.includes("already_gone") || m.includes("bur_old"))).toBe(true);
	});
});

describe("loadWorkspaceGcConfigFromEnv", () => {
	test("defaults when env is empty", () => {
		expect(loadWorkspaceGcConfigFromEnv({})).toEqual({
			ttlMs: DEFAULT_WORKSPACE_GC_TTL_MS,
			tickMs: DEFAULT_WORKSPACE_GC_TICK_MS,
			disabled: false,
		});
	});

	test("parses duration + tick + disabled", () => {
		expect(
			loadWorkspaceGcConfigFromEnv({
				WARREN_WORKSPACE_GC_TTL: "30m",
				WARREN_WORKSPACE_GC_TICK_MS: "60000",
				WARREN_WORKSPACE_GC_DISABLED: "1",
			}),
		).toEqual({ ttlMs: 30 * 60_000, tickMs: 60_000, disabled: true });
	});

	test("throws on malformed ttl", () => {
		expect(() => loadWorkspaceGcConfigFromEnv({ WARREN_WORKSPACE_GC_TTL: "abc" })).toThrow(
			ValidationError,
		);
	});

	test("throws on non-positive tick", () => {
		expect(() => loadWorkspaceGcConfigFromEnv({ WARREN_WORKSPACE_GC_TICK_MS: "0" })).toThrow(
			ValidationError,
		);
	});
});

describe("startWorkspaceGcWorker", () => {
	test("runOnce fires a sweep and increments the tick count", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
		};
		const worker = startWorkspaceGcWorker({
			...tickInput(h),
			setInterval: () => ({}),
			clearInterval: () => {},
		});
		const result = await worker.runOnce();
		expect(result?.destroyed).toBe(1);
		expect(worker.tickCount()).toBe(1);
		await worker.stop();
	});

	test("disabled config never schedules an interval", async () => {
		const h: Harness = { activeRuns: [], terminalRuns: [], destroyed: [] };
		let scheduled = false;
		const worker = startWorkspaceGcWorker({
			...tickInput(h, {}, { disabled: true }),
			setInterval: () => {
				scheduled = true;
				return {};
			},
			clearInterval: () => {},
		});
		expect(scheduled).toBe(false);
		await worker.stop();
	});

	test("single-flight: overlapping fire is skipped", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
		};
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const worker = startWorkspaceGcWorker({
			...tickInput(h, {
				destroyWorkspace: async (id) => {
					h.destroyed.push(id);
					await gate;
					return destroyedOutcome();
				},
			}),
			setInterval: () => ({}),
			clearInterval: () => {},
		});
		const first = worker.runOnce();
		const second = await worker.runOnce();
		expect(second).toBeNull();
		release();
		await first;
		expect(worker.tickCount()).toBe(1);
		await worker.stop();
	});
});

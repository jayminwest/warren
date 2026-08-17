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
function terminalRun(sandboxId: string, endedAt: string): RunRow {
	return { sandboxId, endedAt, state: "succeeded" } as unknown as RunRow;
}

function activeRun(sandboxId: string): RunRow {
	return { sandboxId, endedAt: null, state: "running" } as unknown as RunRow;
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
		expect(out.map((s) => s.sandboxId)).toEqual(["bur_old"]);
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
		expect(out.map((s) => s.sandboxId)).toEqual(["bur_b", "bur_a"]);
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
			[{ sandboxId: "bur_live", state: "running" } as unknown as RunRow],
			[
				{ sandboxId: "bur_x", endedAt: "2026-05-01T00:00:00.000Z" } as unknown as RunRow,
				{ sandboxId: "bur_x", endedAt: "2026-05-02T00:00:00.000Z" } as unknown as RunRow,
				{ sandboxId: null, endedAt: "2026-05-03T00:00:00.000Z" } as unknown as RunRow,
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
	/** Burrow ids whose destruction was persisted (warren-9b77). */
	cleared: string[];
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
				clearBurrowIdForWorkspace: async (sandboxId) => {
					h.cleared.push(sandboxId);
					// Mirror the real repo: null out sandboxId so the next sweep
					// (and the readyz diagnostic) never re-strands the workspace.
					h.terminalRuns = h.terminalRuns.map((r) =>
						r.sandboxId === sandboxId ? ({ ...r, sandboxId: null } as RunRow) : r,
					);
				},
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
			cleared: [],
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
			cleared: [],
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
			cleared: [],
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
			cleared: [],
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

	test("persists a destroy success so the workspace never re-strands (warren-9b77)", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
			cleared: [],
		};
		const input = tickInput(h);
		const first = await runWorkspaceGcTick(input);
		expect(first.destroyed).toBe(1);
		expect(h.cleared).toEqual(["bur_old"]);
		// Convergence: the next sweep finds nothing — the persisted marker
		// (sandboxId nulled) removes the burrow from the candidate universe.
		const second = await runWorkspaceGcTick(input);
		expect(second).toEqual({ scanned: 0, stranded: 0, destroyed: 0, failed: 0 });
		expect(h.destroyed).toEqual(["bur_old"]);
	});

	test("persists an already-gone outcome too (warren-9b77)", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
			cleared: [],
		};
		const input = tickInput(h, {
			destroyWorkspace: async () => ({ status: "already-gone" }),
		});
		const first = await runWorkspaceGcTick(input);
		expect(first.destroyed).toBe(1);
		expect(h.cleared).toEqual(["bur_old"]);
		const second = await runWorkspaceGcTick(input);
		expect(second).toEqual({ scanned: 0, stranded: 0, destroyed: 0, failed: 0 });
	});

	test("does not persist a failed destroy — the workspace stays stranded", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
			cleared: [],
		};
		const result = await runWorkspaceGcTick(
			tickInput(h, {
				destroyWorkspace: async () => ({ status: "failed", error: "worker unreachable" }),
			}),
		);
		expect(result.failed).toBe(1);
		expect(h.cleared).toEqual([]);
	});

	test("a bookkeeping failure is logged and never fails the sweep (warren-9b77)", async () => {
		const h: Harness = {
			activeRuns: [],
			terminalRuns: [terminalRun("bur_old", "2026-05-29T09:00:00.000Z")],
			destroyed: [],
			cleared: [],
		};
		const warnings: string[] = [];
		const base = tickInput(h);
		const result = await runWorkspaceGcTick({
			...base,
			repos: {
				runs: {
					...base.repos.runs,
					clearBurrowIdForWorkspace: async () => {
						throw new Error("db read-only");
					},
				},
			},
			logger: {
				info: () => {},
				warn: (obj) => {
					warnings.push(JSON.stringify(obj));
				},
				error: () => {},
			},
		});
		expect(result.destroyed).toBe(1);
		expect(result.failed).toBe(0);
		expect(warnings.some((w) => w.includes("db read-only"))).toBe(true);
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
			cleared: [],
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
		const h: Harness = { activeRuns: [], terminalRuns: [], destroyed: [], cleared: [] };
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
			cleared: [],
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

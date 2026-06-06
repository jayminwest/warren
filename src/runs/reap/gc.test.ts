import { describe, expect, test } from "bun:test";
import { NotFoundError as BurrowNotFoundError, type DestroyBurrowResult } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/client.ts";
import { ValidationError } from "../../core/errors.ts";
import type { BurrowRow, RunRow } from "../../db/schema.ts";
import {
	buildBurrowActivity,
	DEFAULT_WORKSPACE_GC_TICK_MS,
	DEFAULT_WORKSPACE_GC_TTL_MS,
	findStrandedBurrows,
	loadWorkspaceGcConfigFromEnv,
	runWorkspaceGcTick,
	startWorkspaceGcWorker,
	type WorkspaceGcConfig,
	type WorkspaceGcTickInput,
} from "./gc.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");

function burrow(id: string, addedAt: string, workerId = "local"): BurrowRow {
	return { id, workerId, addedAt };
}

function fakeResult(over: Partial<DestroyBurrowResult> = {}): DestroyBurrowResult {
	return {
		burrowId: "bur_x",
		archived: { events: 0 } as unknown as DestroyBurrowResult["archived"],
		deletedEvents: 3,
		deletedMessages: 1,
		deletedRuns: 2,
		...over,
	};
}

function fakeClient(): BurrowClient {
	return {
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
	} as unknown as BurrowClient;
}

describe("findStrandedBurrows", () => {
	test("flags burrows with only-terminal runs older than the ttl", () => {
		const out = findStrandedBurrows({
			burrows: [burrow("bur_old", "2026-05-29T10:00:00.000Z")],
			activeBurrowIds: new Set(),
			latestEndedAt: new Map(),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out.map((s) => s.burrowId)).toEqual(["bur_old"]);
		expect(out[0]?.ageMs).toBe(2 * 60 * 60_000);
	});

	test("skips burrows with a live run", () => {
		const out = findStrandedBurrows({
			burrows: [burrow("bur_live", "2026-05-01T00:00:00.000Z")],
			activeBurrowIds: new Set(["bur_live"]),
			latestEndedAt: new Map(),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out).toEqual([]);
	});

	test("skips burrows whose latest run ended within the ttl", () => {
		const out = findStrandedBurrows({
			burrows: [burrow("bur_recent", "2026-05-01T00:00:00.000Z")],
			activeBurrowIds: new Set(),
			latestEndedAt: new Map([["bur_recent", "2026-05-29T11:30:00.000Z"]]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out).toEqual([]);
	});

	test("ages off latest endedAt over addedAt", () => {
		// Added long ago but a run finished 10m ago → not yet stranded.
		const out = findStrandedBurrows({
			burrows: [burrow("bur_x", "2026-01-01T00:00:00.000Z")],
			activeBurrowIds: new Set(),
			latestEndedAt: new Map([["bur_x", "2026-05-29T11:50:00.000Z"]]),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out).toEqual([]);
	});

	test("sorts oldest-first", () => {
		const out = findStrandedBurrows({
			burrows: [
				burrow("bur_a", "2026-05-29T10:00:00.000Z"),
				burrow("bur_b", "2026-05-29T06:00:00.000Z"),
			],
			activeBurrowIds: new Set(),
			latestEndedAt: new Map(),
			ttlMs: 60 * 60_000,
			now: NOW,
		});
		expect(out.map((s) => s.burrowId)).toEqual(["bur_b", "bur_a"]);
	});

	test("skips rows with an unparseable timestamp", () => {
		const out = findStrandedBurrows({
			burrows: [burrow("bur_bad", "not-a-date")],
			activeBurrowIds: new Set(),
			latestEndedAt: new Map(),
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
	burrows: BurrowRow[];
	deleted: string[];
	destroyed: string[];
}

function tickInput(
	h: Harness,
	over: Partial<WorkspaceGcTickInput> = {},
	config: Partial<WorkspaceGcConfig> = {},
): WorkspaceGcTickInput {
	return {
		repos: {
			burrows: {
				listAll: async () => h.burrows,
				delete: async (id: string) => {
					h.deleted.push(id);
				},
			},
			runs: {
				listByState: async () => [],
			},
		},
		burrowClientPool: {
			clientFor: async () => ({ client: fakeClient() }),
		},
		config: { ttlMs: 60 * 60_000, tickMs: 1000, disabled: false, ...config },
		now: () => NOW,
		destroyBurrow: async (_client, burrowId) => {
			h.destroyed.push(burrowId);
			return fakeResult({ burrowId });
		},
		...over,
	};
}

describe("runWorkspaceGcTick", () => {
	test("destroys stranded burrows and deletes their placement rows", async () => {
		const h: Harness = {
			burrows: [burrow("bur_old", "2026-05-29T09:00:00.000Z")],
			deleted: [],
			destroyed: [],
		};
		const result = await runWorkspaceGcTick(tickInput(h));
		expect(result).toEqual({ scanned: 1, stranded: 1, destroyed: 1, failed: 0 });
		expect(h.destroyed).toEqual(["bur_old"]);
		expect(h.deleted).toEqual(["bur_old"]);
	});

	test("never touches a burrow with a live run", async () => {
		const h: Harness = {
			burrows: [burrow("bur_live", "2026-05-29T00:00:00.000Z")],
			deleted: [],
			destroyed: [],
		};
		const result = await runWorkspaceGcTick(
			tickInput(h, {
				repos: {
					burrows: {
						listAll: async () => h.burrows,
						delete: async (id: string) => {
							h.deleted.push(id);
						},
					},
					runs: {
						listByState: async (states) =>
							states.includes("running")
								? [{ burrowId: "bur_live", state: "running" } as unknown as RunRow]
								: [],
					},
				},
			}),
		);
		expect(result.destroyed).toBe(0);
		expect(h.destroyed).toEqual([]);
		expect(h.deleted).toEqual([]);
	});

	test("counts a destroy failure without deleting the placement row", async () => {
		const h: Harness = {
			burrows: [burrow("bur_old", "2026-05-29T09:00:00.000Z")],
			deleted: [],
			destroyed: [],
		};
		const result = await runWorkspaceGcTick(
			tickInput(h, {
				destroyBurrow: async () => {
					throw new Error("worker unreachable");
				},
			}),
		);
		expect(result).toEqual({ scanned: 1, stranded: 1, destroyed: 0, failed: 1 });
		expect(h.deleted).toEqual([]);
	});

	test("treats a 404 from burrow as already-gone: deletes placement row and counts as destroyed", async () => {
		const h: Harness = {
			burrows: [burrow("bur_old", "2026-05-29T09:00:00.000Z")],
			deleted: [],
			destroyed: [],
		};
		const logs: string[] = [];
		const result = await runWorkspaceGcTick(
			tickInput(h, {
				destroyBurrow: async () => {
					throw new BurrowNotFoundError("burrow not found");
				},
				logger: {
					info: (obj) => {
						logs.push((obj as { msg?: string })["msg"] ?? JSON.stringify(obj));
					},
					warn: () => {},
					error: () => {},
				},
			}),
		);
		// Counts as destroyed (not failed) so the metric stays accurate.
		expect(result).toEqual({ scanned: 1, stranded: 1, destroyed: 1, failed: 0 });
		// Placement row is pruned so the same burrow isn't retried next sweep.
		expect(h.deleted).toEqual(["bur_old"]);
		// Logged at info, not warn — it's not an error.
		expect(logs.some((m) => m.includes("already_gone") || m.includes("bur_old"))).toBe(true);
	});

	test("counts a clientFor failure as a failed destroy", async () => {
		const h: Harness = {
			burrows: [burrow("bur_old", "2026-05-29T09:00:00.000Z")],
			deleted: [],
			destroyed: [],
		};
		const result = await runWorkspaceGcTick(
			tickInput(h, {
				burrowClientPool: {
					clientFor: async () => {
						throw new Error("no placement row");
					},
				},
			}),
		);
		expect(result.failed).toBe(1);
		expect(h.destroyed).toEqual([]);
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
			burrows: [burrow("bur_old", "2026-05-29T09:00:00.000Z")],
			deleted: [],
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
		const h: Harness = { burrows: [], deleted: [], destroyed: [] };
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
			burrows: [burrow("bur_old", "2026-05-29T09:00:00.000Z")],
			deleted: [],
			destroyed: [],
		};
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const worker = startWorkspaceGcWorker({
			...tickInput(h, {
				destroyBurrow: async (_c, id) => {
					h.destroyed.push(id);
					await gate;
					return fakeResult({ burrowId: id });
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

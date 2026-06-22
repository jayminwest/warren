import { describe, expect, test } from "bun:test";
import type { DestroyBurrowResult } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/client.ts";
import type { PreviewState, RunMode } from "../../db/schema.ts";
import { destroyBurrowWorkspaceById, runWorkspaceDestroy } from "./destroy.ts";

function fakeClient(): BurrowClient {
	return {
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
	} as unknown as BurrowClient;
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

interface Harness {
	events: { kind: string; payload: unknown }[];
	failures: { step: string; message: string }[];
	deleted: string[];
}

function harness(): Harness {
	return { events: [], failures: [], deleted: [] };
}

function deps(h: Harness) {
	return {
		repos: {
			burrows: {
				delete: async (id: string) => {
					h.deleted.push(id);
				},
			},
		},
		emit: async (kind: string, payload: unknown) => {
			h.events.push({ kind, payload });
		},
		fail: async (step: "workspace_destroy", err: unknown) => {
			h.failures.push({ step, message: err instanceof Error ? err.message : String(err) });
		},
	};
}

function run(
	over: Partial<{ burrowId: string | null; mode: RunMode; previewState: PreviewState | null }> = {},
) {
	return {
		id: "run_1",
		burrowId: "bur_x" as string | null,
		mode: "batch" as RunMode,
		previewState: null as PreviewState | null,
		...over,
	};
}

describe("runWorkspaceDestroy", () => {
	test("destroys the workspace, deletes the row, and emits workspace_destroyed", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			workerClient: fakeClient(),
			destroyBurrow: async () => fakeResult(),
			...deps(h),
		});
		expect(destroyed).toBe(true);
		expect(h.deleted).toEqual(["bur_x"]);
		expect(h.events).toHaveLength(1);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroyed");
		expect(h.events[0]?.payload).toMatchObject({
			burrowId: "bur_x",
			archived: true,
			deletedEvents: 3,
			deletedMessages: 1,
			deletedRuns: 2,
		});
		expect(h.failures).toEqual([]);
	});

	test("reports archived:false when the destroy result carries no archive", async () => {
		const h = harness();
		await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			workerClient: fakeClient(),
			destroyBurrow: async () => fakeResult({ archived: null }),
			...deps(h),
		});
		expect(h.events[0]?.payload).toMatchObject({ archived: false });
	});

	test("skips without an event when there is no burrow", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run({ burrowId: null }),
			previewLaunchState: null,
			workerClient: fakeClient(),
			destroyBurrow: async () => fakeResult(),
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.events).toEqual([]);
		expect(h.deleted).toEqual([]);
	});

	test("skips without an event when the worker client is unresolved", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			workerClient: null,
			destroyBurrow: async () => fakeResult(),
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.events).toEqual([]);
	});

	test("skips conversation runs and emits a skipped event (warren-c770)", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run({ mode: "conversation" }),
			previewLaunchState: null,
			workerClient: fakeClient(),
			destroyBurrow: async () => fakeResult(),
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.deleted).toEqual([]);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroy_skipped");
		expect(h.events[0]?.payload).toMatchObject({ reason: "conversation_run" });
	});

	test("skips when this reap launched a live preview", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: "live",
			workerClient: fakeClient(),
			destroyBurrow: async () => fakeResult(),
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.events[0]?.payload).toMatchObject({ reason: "preview_active" });
	});

	test("skips when the row already has a live/starting preview", async () => {
		for (const previewState of ["live", "starting"] as const) {
			const h = harness();
			const destroyed = await runWorkspaceDestroy({
				run: run({ previewState }),
				previewLaunchState: null,
				workerClient: fakeClient(),
				destroyBurrow: async () => fakeResult(),
				...deps(h),
			});
			expect(destroyed).toBe(false);
			expect(h.events[0]?.payload).toMatchObject({ reason: "preview_active" });
		}
	});

	test("destroys when a preview launch failed (no live sidecar)", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: "failed",
			workerClient: fakeClient(),
			destroyBurrow: async () => fakeResult(),
			...deps(h),
		});
		expect(destroyed).toBe(true);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroyed");
	});

	test("a destroy failure is best-effort: reap_failed, no row delete", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			workerClient: fakeClient(),
			destroyBurrow: async () => {
				throw new Error("burrow unreachable");
			},
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.deleted).toEqual([]);
		expect(h.failures).toHaveLength(1);
		expect(h.failures[0]?.step).toBe("workspace_destroy");
		expect(h.failures[0]?.message).toContain("burrow unreachable");
		expect(h.events.some((e) => e.kind === "reap.workspace_destroyed")).toBe(false);
	});
});

function poolFor(client: BurrowClient | (() => never)) {
	return {
		clientFor: async () => {
			if (typeof client === "function") client();
			return { client: client as BurrowClient };
		},
	};
}

function byIdDeps(h: Harness) {
	const { repos, emit } = deps(h);
	return { repos, emit };
}

describe("destroyBurrowWorkspaceById (warren-4f01)", () => {
	test("resolves the worker, destroys the burrow, deletes the row, emits destroyed", async () => {
		const h = harness();
		const destroyed = await destroyBurrowWorkspaceById({
			burrowId: "bur_x",
			mode: "batch",
			burrowClientPool: poolFor(fakeClient()),
			destroyBurrow: async () => fakeResult(),
			...byIdDeps(h),
		});
		expect(destroyed).toBe(true);
		expect(h.deleted).toEqual(["bur_x"]);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroyed");
	});

	test("skips conversation runs without resolving a worker (warren-c770)", async () => {
		const h = harness();
		let resolved = false;
		const destroyed = await destroyBurrowWorkspaceById({
			burrowId: "bur_x",
			mode: "conversation",
			burrowClientPool: {
				clientFor: async () => {
					resolved = true;
					return { client: fakeClient() };
				},
			},
			destroyBurrow: async () => fakeResult(),
			...byIdDeps(h),
		});
		expect(destroyed).toBe(false);
		expect(resolved).toBe(false);
		expect(h.deleted).toEqual([]);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroy_skipped");
	});

	test("a worker-resolution failure degrades to a destroy_failed event", async () => {
		const h = harness();
		const destroyed = await destroyBurrowWorkspaceById({
			burrowId: "bur_x",
			mode: "batch",
			burrowClientPool: poolFor(() => {
				throw new Error("worker unreachable");
			}),
			destroyBurrow: async () => fakeResult(),
			...byIdDeps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.deleted).toEqual([]);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroy_failed");
		expect(h.events[0]?.payload).toMatchObject({ step: "resolve_worker" });
	});

	test("a destroy failure degrades to a destroy_failed event, no row delete", async () => {
		const h = harness();
		const destroyed = await destroyBurrowWorkspaceById({
			burrowId: "bur_x",
			mode: "batch",
			burrowClientPool: poolFor(fakeClient()),
			destroyBurrow: async () => {
				throw new Error("destroy rejected");
			},
			...byIdDeps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.deleted).toEqual([]);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroy_failed");
		expect(h.events[0]?.payload).toMatchObject({ step: "destroy" });
	});
});

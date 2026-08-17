import { describe, expect, test } from "bun:test";
import type { PreviewState, RunMode } from "../../db/schema.ts";
import type { TeardownResult } from "../../runtime/contract.ts";
import { runWorkspaceDestroy } from "./destroy.ts";

/** The seam `runWorkspaceDestroy` now consumes: `provider.terminate`'s result. */
function fakeTeardown(over: Partial<TeardownResult> = {}): TeardownResult {
	return { archived: true, deletedEvents: 3, deletedMessages: 1, deletedRuns: 2, ...over };
}

interface Harness {
	events: { kind: string; payload: unknown }[];
	failures: { step: string; message: string }[];
}

function harness(): Harness {
	return { events: [], failures: [] };
}

function deps(h: Harness) {
	return {
		emit: async (kind: string, payload: unknown) => {
			h.events.push({ kind, payload });
		},
		fail: async (step: "workspace_destroy", err: unknown) => {
			h.failures.push({ step, message: err instanceof Error ? err.message : String(err) });
		},
	};
}

function run(
	over: Partial<{
		sandboxId: string | null;
		mode: RunMode;
		previewState: PreviewState | null;
	}> = {},
) {
	return {
		id: "run_1",
		sandboxId: "bur_x" as string | null,
		mode: "batch" as RunMode,
		previewState: null as PreviewState | null,
		...over,
	};
}

describe("runWorkspaceDestroy", () => {
	test("destroys the workspace and emits workspace_destroyed", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			terminate: async () => fakeTeardown(),
			...deps(h),
		});
		expect(destroyed).toBe(true);
		expect(h.events).toHaveLength(1);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroyed");
		expect(h.events[0]?.payload).toMatchObject({
			sandboxId: "bur_x",
			archived: true,
			deletedEvents: 3,
			deletedMessages: 1,
			deletedRuns: 2,
		});
		expect(h.failures).toEqual([]);
	});

	test("reports archived:false when the teardown carries no archive", async () => {
		const h = harness();
		await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			terminate: async () => fakeTeardown({ archived: false }),
			...deps(h),
		});
		expect(h.events[0]?.payload).toMatchObject({ archived: false });
	});

	test("skips without an event when there is no burrow", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run({ sandboxId: null }),
			previewLaunchState: null,
			terminate: async () => fakeTeardown(),
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.events).toEqual([]);
	});

	test("skips without an event when the terminate seam is unresolved", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			terminate: null,
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.events).toEqual([]);
	});

	test("skips and preserves the workspace when the branch push failed (warren-495d)", async () => {
		const h = harness();
		let terminated = false;
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			branchPushFailed: true,
			terminate: async () => {
				terminated = true;
				return fakeTeardown();
			},
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(terminated).toBe(false);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroy_skipped");
		expect(h.events[0]?.payload).toMatchObject({ reason: "branch_push_failed" });
	});

	test("skips when this reap launched a live preview", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: "live",
			terminate: async () => fakeTeardown(),
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
				terminate: async () => fakeTeardown(),
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
			terminate: async () => fakeTeardown(),
			...deps(h),
		});
		expect(destroyed).toBe(true);
		expect(h.events[0]?.kind).toBe("reap.workspace_destroyed");
	});

	test("a destroy failure is best-effort: reap_failed", async () => {
		const h = harness();
		const destroyed = await runWorkspaceDestroy({
			run: run(),
			previewLaunchState: null,
			terminate: async () => {
				throw new Error("burrow unreachable");
			},
			...deps(h),
		});
		expect(destroyed).toBe(false);
		expect(h.failures).toHaveLength(1);
		expect(h.failures[0]?.step).toBe("workspace_destroy");
		expect(h.failures[0]?.message).toContain("burrow unreachable");
		expect(h.events.some((e) => e.kind === "reap.workspace_destroyed")).toBe(false);
	});
});

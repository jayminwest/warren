/**
 * warren-d31b (gh #1307): a THROWN `provider.workspaceInfo` or
 * `provider.finalize` leaves delivery unknown. Reap must fail closed
 * (`finalize_failed`) and either salvage the work or preserve the workspace —
 * never report `succeeded` and destroy the only copy of the agent's commits.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FinalizeResult, RuntimeProvider, WorkspaceInfo } from "../../runtime/contract.ts";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";
import type { ReapExec } from "./types.ts";

/** A K8s-shaped provider (no host workspace) whose finalize throws or returns `result`. */
function k8sProvider(result: FinalizeResult | null): {
	provider: RuntimeProvider;
	terminated: () => number;
} {
	let terminated = 0;
	const provider = {
		capabilities: { previewPorts: false },
		workspaceInfo: async (): Promise<WorkspaceInfo> => ({ workspacePath: null, branch: "b" }),
		finalize: async (): Promise<FinalizeResult> => {
			if (result === null) throw new Error("finalize transport died");
			return result;
		},
		terminate: async () => {
			terminated += 1;
			return { archived: true, deletedEvents: 0, deletedMessages: 0, deletedRuns: 0 };
		},
	} as unknown as RuntimeProvider;
	return { provider, terminated: () => terminated };
}

/** Exec where the rescue push succeeds (or fails when `failRescue`). */
function rescueExec(failRescue: boolean): ReapExec {
	return {
		run: async (_cmd, args) => {
			if (args[0] === "push" && failRescue) throw new Error("rescue push declined");
			if (args[0] === "rev-list") return { stdout: "1", stderr: "" };
			return { stdout: "", stderr: "" };
		},
	};
}

describe("reapRun when a provider call throws (warren-d31b)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	function localDeps(exec: ReapExec, opts: { finalizeThrows?: boolean; lookupThrows?: boolean }) {
		const fake = fakeBurrowClient(makeBurrow());
		if (opts.lookupThrows === true) fake.plan.workspaceInfoError = new Error("burrow 404");
		const deps = reapDeps(fake, { fs: fakeFs().fs, exec });
		if (opts.finalizeThrows === true) {
			deps.runtimeProvider.finalize = async () => {
				throw new Error("finalize transport died");
			};
		}
		const deletes = () => fake.calls.filter((c) => c.method === "DELETE").length;
		return { deps, deletes };
	}

	test("local finalize throwing fails the run and salvages before destroy", async () => {
		const exec = rescueExec(false);
		const { deps, deletes } = localDeps(exec, { finalizeThrows: true });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...deps,
			fs: fakeFs().fs,
			exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("finalize_failed");
		expect(result.branchPushed).toBe(false);
		expect(result.errors.map((x) => x.step)).toContain("finalize");
		expect(result.salvageRescueRef).toBe(`warren/rescue/${ctx.runId}`);
		// The work is durable on the rescue ref, so destroy proceeds.
		expect(result.workspaceDestroyed).toBe(true);
		expect(deletes()).toBe(1);
	});

	test("local finalize throwing with a failed salvage preserves the workspace", async () => {
		const exec = rescueExec(true);
		const { deps, deletes } = localDeps(exec, { finalizeThrows: true });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...deps,
			fs: fakeFs().fs,
			exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("finalize_failed");
		expect(result.salvageRescueRef).toBeNull();
		expect(result.salvagePath).toBeNull();
		expect(result.workspaceDestroyed).toBe(false);
		expect(deletes()).toBe(0);
	});

	test("local workspaceInfo throwing fails the run and preserves the workspace", async () => {
		const e = fakeExec();
		const { deps, deletes } = localDeps(e.exec, { lookupThrows: true });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...deps,
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("finalize_failed");
		expect(result.errors.map((x) => x.step)).toContain("workspace_lookup");
		expect(result.workspaceDestroyed).toBe(false);
		expect(deletes()).toBe(0);
	});

	test("k8s finalize throwing fails the run and never terminates the pod", async () => {
		const fake = k8sProvider(null);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: fake.provider,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("finalize_failed");
		expect(result.branchPushed).toBe(false);
		expect(result.errors.map((x) => x.step)).toContain("finalize");
		expect(result.workspaceDestroyed).toBe(false);
		expect(fake.terminated()).toBe(0);
	});

	test("k8s no-op finalize (pushed, zero commits ahead) stays succeeded and destroys", async () => {
		const fake = k8sProvider({
			pushed: true,
			commitsAhead: 0,
			emptyPush: false,
			dirty: false,
			workspacePlansBody: null,
			artifacts: {},
			prBranch: null,
			stages: [{ stage: "branch_push", status: "ok" }],
			events: [],
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: fake.provider,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("succeeded");
		expect(result.failureReason).toBeNull();
		expect(result.workspaceDestroyed).toBe(true);
		expect(fake.terminated()).toBe(1);
	});
});

/**
 * warren-cd3b: salvage-before-destroy at the reapRun level (LocalProvider).
 * When the finalize branch push never lands, reap must capture the workspace's
 * committed work BEFORE deciding the workspace's fate — and a successful
 * capture lifts the warren-495d destroy skip (the work is durable elsewhere).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeForge,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";
import type { ReapExec } from "./types.ts";

/**
 * Exec that fails ONLY the primary branch push (`HEAD:agent/...`); the rescue
 * push (`HEAD:refs/heads/warren/rescue/...`) and `git bundle` succeed.
 */
function salvageExec(opts: { failRescueToo?: boolean } = {}): {
	exec: ReapExec;
	calls: { args: readonly string[] }[];
} {
	const calls: { args: readonly string[] }[] = [];
	return {
		calls,
		exec: {
			run: async (_cmd, args) => {
				calls.push({ args });
				if (args[0] === "push") {
					const refspec = args[2] ?? "";
					if (refspec.includes("refs/heads/warren/rescue/")) {
						if (opts.failRescueToo === true) throw new Error("rescue push declined");
						return { stdout: "", stderr: "" };
					}
					throw new Error("remote rejected: push protection");
				}
				if (args[0] === "rev-list") return { stdout: "1", stderr: "" };
				return { stdout: "", stderr: "" };
			},
		},
	};
}

describe("reapRun salvage-before-destroy (warren-cd3b)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("the rescue push authenticates with a per-spawn credential minted from the forge (warren-4e1c)", async () => {
		const f = fakeFs();
		const pushes: { args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
		const exec: ReapExec = {
			run: async (_cmd, args, o) => {
				if (args[0] === "push") {
					pushes.push({ args, ...(o.env !== undefined ? { env: o.env } : {}) });
					if ((args[2] ?? "").includes("refs/heads/warren/rescue/")) {
						return { stdout: "", stderr: "" };
					}
					throw new Error("remote rejected: push protection");
				}
				if (args[0] === "rev-list") return { stdout: "1", stderr: "" };
				return { stdout: "", stderr: "" };
			},
		};
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec }),
			broker: ctx.broker,
			fs: f.fs,
			exec,
			forge: fakeForge(),
		});

		expect(result.salvageRescueRef).toBe(`warren/rescue/${ctx.runId}`);
		// Both the finalize branch push and the rescue push minted the credential
		// per spawn from the forge (FakeForge's static secret).
		expect(pushes.length).toBeGreaterThanOrEqual(2);
		for (const push of pushes) {
			expect(push.env?.GIT_CONFIG_KEY_0).toBe(
				"url.https://fake:fake-credential@github.com/.insteadOf",
			);
			expect(push.env?.GIT_CONFIG_VALUE_0).toBe("https://github.com/");
		}
	});

	test("a failed push is rescued to a rescue ref, stamped on the row, and destroy proceeds", async () => {
		const f = fakeFs();
		const e = salvageExec();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
			salvageDir: "/data/salvage",
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("finalize_failed");
		expect(result.salvageRescueRef).toBe(`warren/rescue/${ctx.runId}`);
		expect(result.salvagePath).toBeNull();
		// The run row carries the recovery location for operators.
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.salvageRef).toBe(`warren/rescue/${ctx.runId}`);
		// The event stream surfaces it.
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const salvaged = events.find((ev) => ev.kind === "reap.workspace_salvaged");
		expect(salvaged?.payloadJson).toMatchObject({ rescueRef: `warren/rescue/${ctx.runId}` });
		// The work is safe, so the warren-495d preserve-skip is LIFTED.
		expect(result.workspaceDestroyed).toBe(true);
		expect(events.find((ev) => ev.kind === "reap.workspace_destroy_skipped")).toBeUndefined();
	});

	test("a failed push AND failed rescue push falls back to the durable bundle", async () => {
		const f = fakeFs();
		const e = salvageExec({ failRescueToo: true });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
			salvageDir: "/data/salvage",
		});

		expect(result.salvageRescueRef).toBeNull();
		expect(result.salvagePath).toBe(`/data/salvage/${ctx.runId}.bundle`);
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.salvagePath).toBe(`/data/salvage/${ctx.runId}.bundle`);
		expect(result.workspaceDestroyed).toBe(true);
	});

	test("when every capture fails the workspace is preserved and the event says so", async () => {
		const f = fakeFs();
		const e = salvageExec({ failRescueToo: true });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
			// No salvageDir: the rescue push is the only capture form available.
		});

		expect(result.salvageRescueRef).toBeNull();
		expect(result.salvagePath).toBeNull();
		expect(result.workspaceDestroyed).toBe(false);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "reap.workspace_salvage_failed")).toBe(true);
		const skipped = events.find((ev) => ev.kind === "reap.workspace_destroy_skipped");
		expect(skipped?.payloadJson).toMatchObject({ reason: "branch_push_failed" });
	});
});

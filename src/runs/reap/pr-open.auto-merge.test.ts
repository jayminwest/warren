import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { Forge } from "../../forge/contract.ts";
import type { AutoMergeConfig } from "../../warren-config/pr-config.ts";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeForge,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";

/**
 * Reap-level coverage for the auto-merge arm sub-step (warren-14d6 /
 * pl-92a3 step 6): the arm rides the real `pr_open` pipeline path — PR
 * opened through the fake forge, policy resolved through the fake exec,
 * exactly one event on the run stream, and the run's terminal state
 * untouched in every case. The module-level decision table lives in
 * `auto-merge-arm.test.ts`; this file proves the WIRING.
 */

const AUTO_OPEN = { enabled: true, token: "ghp_xyz", warrenBaseUrl: null } as const;

/** The project's opt-in block (the engagement gate threaded into reap). */
const OPT_IN: AutoMergeConfig = { method: "squash", protectedPaths: [] };

/** Base-ref `.warren/config.yaml` carrying the same opt-in. */
const BASE_CONFIG_YAML = "pr:\n  autoMerge:\n    method: squash\n";

/** Base-ref config with a protected path (the policy resolves from the base). */
const PROTECTED_BASE_CONFIG_YAML =
	"pr:\n  autoMerge:\n    method: squash\n    protectedPaths:\n      - docs/\n";

interface ReapCase {
	readonly exec: ReturnType<typeof fakeExec>;
	readonly forge: Forge;
	readonly prAutoMerge?: AutoMergeConfig;
}

/** Run a full succeeded reap with the PR-open phase armed per the case. */
async function reapWithPrOpen(ctx: Ctx, c: ReapCase) {
	return reapRun({
		runId: ctx.runId,
		outcome: "succeeded",
		repos: ctx.repos,
		...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: c.exec.exec }),
		fs: fakeFs().fs,
		exec: c.exec.exec,
		autoOpenPr: AUTO_OPEN,
		forge: c.forge,
		...(c.prAutoMerge !== undefined ? { prAutoMerge: c.prAutoMerge } : {}),
	});
}

/** The auto-merge events this run emitted (exactly-once rule lives at the caller). */
async function autoMergeEvents(ctx: Ctx) {
	const events = await ctx.repos.events.listByRun(ctx.runId);
	return events.filter((ev) => ev.kind.startsWith("reap.auto_merge_"));
}

/** Assert the arm never disturbed the run's terminal outcome or error trail. */
async function assertRunUntouched(ctx: Ctx, result: Awaited<ReturnType<typeof reapRun>>) {
	expect(result.state).toBe("succeeded");
	expect(result.failureReason).toBeNull();
	const events = await ctx.repos.events.listByRun(ctx.runId);
	expect(events.find((ev) => ev.kind === "reap_failed")).toBeUndefined();
}

describe("reapRun auto-merge arm sub-step (warren-14d6)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup(`${tmpdir()}/unused-host`);
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("emits nothing and never calls the forge when the project never opted in", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		forge.armAutoMerge = (() => {
			throw new Error("armAutoMerge must not be called when pr.autoMerge is absent");
		}) as typeof forge.armAutoMerge;
		const e = fakeExec({
			revListCount: "2",
			showStdout: BASE_CONFIG_YAML,
			nameOnlyDiff: "src/a.ts\0",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge });
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		expect(await autoMergeEvents(ctx)).toHaveLength(0);
		// The engagement gate returns before any git read: no `git show`, no diff.
		expect(e.calls.some((c) => c.args[0] === "show")).toBe(false);
		expect(e.calls.some((c) => c.args.includes("--name-only"))).toBe(false);
		await assertRunUntouched(ctx, result);
	});

	test("arms the PR reap just opened and emits the full armed payload", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		const e = fakeExec({
			revListCount: "2",
			showStdout: BASE_CONFIG_YAML,
			nameOnlyDiff: "src/a.ts\0",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		expect(forge.store.getPr("x/y", 1)?.autoMerge).toBe("armed");
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_armed");
		expect(events[0]?.payloadJson).toMatchObject({
			prUrl: "fake://x/y/pulls/1",
			prNumber: 1,
			method: "squash",
			outcome: "armed",
		});
		await assertRunUntouched(ctx, result);
	});

	test("reports already_armed as success on the resolved-existing path", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		// A PR that already covers head→base (find-then-open resolves to it) and
		// already carries an auto-merge request — the re-reap / double-armer shape.
		forge.store.openPr(
			"x/y",
			{
				headBranch: "agent/refactor-bot/run-1",
				baseBranch: "main",
				title: "t",
				body: "b",
			},
			"fake-head-agent/refactor-bot/run-1",
		);
		forge.store.setAutoMerge("x/y", 1, "armed");
		const e = fakeExec({
			revListCount: "2",
			showStdout: BASE_CONFIG_YAML,
			nameOnlyDiff: "src/a.ts\0",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_armed");
		expect(events[0]?.payloadJson).toMatchObject({ outcome: "already_armed" });
		await assertRunUntouched(ctx, result);
	});

	test("skips with reason off when the base ref carries no pr.autoMerge block", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		const e = fakeExec({ revListCount: "2", showStdout: "", nameOnlyDiff: "src/a.ts\0" });
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		expect(forge.store.getPr("x/y", 1)?.autoMerge).toBe("unarmed");
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_skipped");
		expect(events[0]?.payloadJson).toMatchObject({ reason: "off" });
		await assertRunUntouched(ctx, result);
	});

	test("skips with reason unsupported_forge when the forge cannot arm", async () => {
		const forge = fakeForge(); // default capability: autoMergeArm false
		const e = fakeExec({
			revListCount: "2",
			showStdout: BASE_CONFIG_YAML,
			nameOnlyDiff: "src/a.ts\0",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_skipped");
		expect(events[0]?.payloadJson).toMatchObject({ reason: "unsupported_forge" });
		await assertRunUntouched(ctx, result);
	});

	test("skips with reason protected_path naming the matched files", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		const e = fakeExec({
			revListCount: "2",
			showStdout: PROTECTED_BASE_CONFIG_YAML,
			nameOnlyDiff: "docs/a.md\0src/b.ts\0",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_skipped");
		expect(events[0]?.payloadJson).toMatchObject({
			reason: "protected_path",
			paths: ["docs/a.md"],
		});
		await assertRunUntouched(ctx, result);
	});

	test("skips with reason config_changed when the diff touches .warren/config.yaml", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		const e = fakeExec({
			revListCount: "2",
			showStdout: BASE_CONFIG_YAML,
			nameOnlyDiff: "src/b.ts\0.warren/config.yaml\0",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_skipped");
		expect(events[0]?.payloadJson).toMatchObject({
			reason: "config_changed",
			paths: [".warren/config.yaml"],
		});
		await assertRunUntouched(ctx, result);
	});

	test("skips with reason empty_diff on a computed-empty changed-path list", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		const e = fakeExec({ revListCount: "2", showStdout: BASE_CONFIG_YAML, nameOnlyDiff: "" });
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_skipped");
		expect(events[0]?.payloadJson).toMatchObject({ reason: "empty_diff" });
		await assertRunUntouched(ctx, result);
	});

	test("skips with reason diff_unreadable when the changed-path read fails", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		const e = fakeExec({
			revListCount: "2",
			showStdout: BASE_CONFIG_YAML,
			failNameOnlyDiff: "bad ref",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_skipped");
		expect(events[0]?.payloadJson).toMatchObject({ reason: "diff_unreadable" });
		await assertRunUntouched(ctx, result);
	});

	test("reports a forge refusal as not_armed without failing the run", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		forge.scriptAutoMergeArm({
			refusal: "clean_status",
			message: "Pull request is in clean status",
		});
		const e = fakeExec({
			revListCount: "2",
			showStdout: BASE_CONFIG_YAML,
			nameOnlyDiff: "src/a.ts\0",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_not_armed");
		expect(events[0]?.payloadJson).toMatchObject({
			reason: "clean_status",
			message: "Pull request is in clean status",
		});
		await assertRunUntouched(ctx, result);
	});

	test("collapses a throwing armAutoMerge into not_armed reason unknown", async () => {
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		// The contract says armAutoMerge never throws; the step must survive a
		// provider that breaks it (warren-14d6 hard invariant).
		forge.armAutoMerge = (() => {
			throw new Error("transport exploded");
		}) as typeof forge.armAutoMerge;
		const e = fakeExec({
			revListCount: "2",
			showStdout: BASE_CONFIG_YAML,
			nameOnlyDiff: "src/a.ts\0",
		});
		const result = await reapWithPrOpen(ctx, { exec: e, forge, prAutoMerge: OPT_IN });
		const events = await autoMergeEvents(ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("reap.auto_merge_not_armed");
		expect(events[0]?.payloadJson).toMatchObject({ reason: "unknown" });
		await assertRunUntouched(ctx, result);
	});
});

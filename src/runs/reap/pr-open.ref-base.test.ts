/**
 * warren-8cbf: the run's frozen clone ref is the PR base. A plan-run child
 * dispatched with ref=<branch> opens its PR against <branch> (merging into
 * the ref IS the parent-branch advance); a run whose ref IS its push branch
 * (the repair-run pattern) never opens a head==base PR; a ref-less dispatch
 * keeps the pre-warren-8cbf defaultBranch behavior (covered by the main
 * pr-open suite).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
	TEST_REPO_REF,
} from "./test-helpers.ts";

const AUTO_OPEN = { enabled: true, token: "ghp_xyz", warrenBaseUrl: null } as const;

describe("reapRun pr_open base resolution (warren-8cbf)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	async function createRefRun(ref: string | null, targetBranch?: string): Promise<string> {
		const parent = await ctx.repos.runs.require(ctx.runId);
		const run = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId: parent.projectId as string,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "plan-run",
			...(ref !== null ? { ref } : {}),
			...(targetBranch !== undefined ? { targetBranch } : {}),
			sandboxId: "bur_bbbbbbbbbbbb",
			sandboxRunId: "run_wwwwwwwwwwww",
		});
		await ctx.repos.runs.markRunning(run.id);
		return run.id;
	}

	test("opens the PR against the run's frozen clone ref, not defaultBranch (warren-8cbf)", async () => {
		const runId = await createRefRun("feature/parent");
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		const record = forge.store.getPr("x/y", 1);
		expect(record?.headBranch).toBe("agent/refactor-bot/run-1");
		expect(record?.baseBranch).toBe("feature/parent");
		const events = await ctx.repos.events.listByRun(runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")?.payloadJson).toMatchObject({
			baseBranch: "feature/parent",
		});
	});

	test("find-then-open resolves an existing PR against the ref base (warren-8cbf)", async () => {
		const runId = await createRefRun("feature/parent");
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		// A previous reap already opened the PR for this head→ref base.
		const first = await forge.openPullRequest(TEST_REPO_REF, {
			title: "earlier reap",
			body: "earlier body",
			headBranch: "agent/refactor-bot/run-1",
			baseBranch: "feature/parent",
		});
		expect(first.ok).toBe(true);
		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		expect(result.errors.map((x) => x.step)).not.toContain("pr_open");
		const events = await ctx.repos.events.listByRun(runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")?.payloadJson).toMatchObject({
			mode: "exists",
		});
	});

	test("skips pr_open when the run's ref IS its push branch (repair-run pattern, warren-8cbf)", async () => {
		// A repair run cloned from an existing branch and pushes back onto it
		// directly: branch === ref. Threading the ref as the PR base must not
		// produce a head==base PR for these runs.
		const runId = await createRefRun("agent/refactor-bot/run-1", "agent/refactor-bot/run-1");
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.branchPushed).toBe(true);
		expect(result.prUrl).toBeNull();
		expect(forge.store.getPr("x/y", 1)).toBeNull();
		const skipped = (await ctx.repos.events.listByRun(runId)).find(
			(ev) => ev.kind === "reap.pr_open_skipped",
		);
		expect(skipped?.payloadJson).toMatchObject({ reason: "branch_is_base" });
	});
});

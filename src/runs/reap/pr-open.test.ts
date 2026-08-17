import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	ForgeError,
	ForgeResult,
	PullRequestDraft,
	PullRequestRef,
	RepoRef,
} from "../../forge/contract.ts";
import { FAKE_FORGE_KIND } from "../../forge/fake/fake-forge.ts";
import { GitHubForge } from "../../forge/github/provider.ts";
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
	stubForge,
	TEST_REPO_REF,
} from "./test-helpers.ts";

/** A PullRequestRef at the fake grammar, for stubbed openPullRequest results. */
function fakePrRef(number: number): PullRequestRef {
	return {
		forge: FAKE_FORGE_KIND,
		key: `${TEST_REPO_REF.key}#${number}`,
		number,
		webUrl: `fake://${TEST_REPO_REF.key}/pulls/${number}`,
	};
}

function forgeErr(kind: ForgeError["kind"], detail: string): ForgeResult<PullRequestRef> {
	return { ok: false, error: { kind, detail } };
}

/** A queued-response `openPullRequest` override for the conflict-retry tests. */
function queuedOpen(responses: readonly ForgeResult<PullRequestRef>[]): {
	openPullRequest: (ref: RepoRef, req: PullRequestDraft) => Promise<ForgeResult<PullRequestRef>>;
	calls: PullRequestDraft[];
} {
	const calls: PullRequestDraft[] = [];
	let i = 0;
	return {
		calls,
		openPullRequest: (_ref, req) => {
			calls.push(req);
			const r = responses[i++];
			if (r === undefined) throw new Error("queuedOpen: out of responses");
			return Promise.resolve(r);
		},
	};
}

const AUTO_OPEN = { enabled: true, token: "ghp_xyz", warrenBaseUrl: null } as const;

describe("reapRun pr_open sub-step (warren-f6af; Forge seam warren-45e6)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("opens PR after a successful push with real commits and persists prUrl", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		const record = forge.store.getPr("x/y", 1);
		expect(record?.headBranch).toBe("agent/refactor-bot/run-1");
		expect(record?.baseBranch).toBe("main");
		expect((await ctx.repos.runs.require(ctx.runId)).prUrl).toBe("fake://x/y/pulls/1");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const opened = events.find((ev) => ev.kind === "reap.pr_opened");
		expect(opened?.payloadJson).toMatchObject({ prUrl: "fake://x/y/pulls/1", mode: "created" });
		const completed = events.find((ev) => ev.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ prUrl: "fake://x/y/pulls/1" });
	});

	test("skips pr_open when autoOpenPr is omitted (default off in tests)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			forge,
		});
		expect(result.prUrl).toBeNull();
		expect(
			forge.store.findPr("x/y", { headBranch: "agent/refactor-bot/run-1", baseBranch: "main" }),
		).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")).toBeUndefined();
	});

	test("skips pr_open when the forge seam is not wired (tests)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
		});
		expect(result.prUrl).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")).toBeUndefined();
		expect(events.find((ev) => ev.kind === "reap_failed")).toBeUndefined();
	});

	test("skips pr_open when autoOpenPr is disabled", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: false, warrenBaseUrl: null },
			forge,
		});
		expect(result.prUrl).toBeNull();
		expect(forge.store.getPr("x/y", 1)).toBeNull();
	});

	test("skips pr_open when outcome is failed (conservative V1)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.prUrl).toBeNull();
		expect(forge.store.getPr("x/y", 1)).toBeNull();
	});

	test("skips pr_open when push lands no commits (commitsAhead === 0)", async () => {
		const e = fakeExec({ revListCount: "0" });
		const forge = fakeForge();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.prUrl).toBeNull();
		expect(forge.store.getPr("x/y", 1)).toBeNull();
	});

	test("skips pr_open when branch matches project.defaultBranch", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow({ branch: "main" })), {
				fs: fakeFs().fs,
				exec: e.exec,
			}),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.prUrl).toBeNull();
		expect(forge.store.getPr("x/y", 1)).toBeNull();
	});

	test("skips pr_open when push failed", async () => {
		const e = fakeExec({ fail: "remote rejected" });
		const forge = fakeForge();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.branchPushed).toBe(false);
		expect(result.prUrl).toBeNull();
		expect(forge.store.getPr("x/y", 1)).toBeNull();
	});

	test("emits reap_failed step=pr_open when the forge holds no credential", async () => {
		const e = fakeExec({ revListCount: "2" });
		// A real GitHubForge with an empty token: every method returns
		// no_credential BEFORE any transport, so no fetch seam is needed.
		const forge = new GitHubForge({ token: "" });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, warrenBaseUrl: null },
			forge,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.state).toBe("succeeded");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const failed = events.find(
			(ev) =>
				ev.kind === "reap_failed" &&
				typeof ev.payloadJson === "object" &&
				ev.payloadJson !== null &&
				(ev.payloadJson as { step?: string }).step === "pr_open",
		);
		expect(failed).toBeDefined();
		expect(JSON.stringify(failed?.payloadJson)).toContain("no_credential");
	});

	test("emits reap_failed step=pr_open when no forge owns the clone URL", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = stubForge({ parseRepoRef: () => null });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.errors.find((x) => x.step === "pr_open")?.message).toContain("unowned_url");
		expect(result.state).toBe("succeeded");
	});

	test("treats an already-open PR (mode=exists) as success and persists the existing url", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		// A previous reap already opened the PR for this head→base.
		const first = await forge.openPullRequest(TEST_REPO_REF, {
			title: "earlier reap",
			body: "earlier body",
			headBranch: "agent/refactor-bot/run-1",
			baseBranch: "main",
		});
		expect(first.ok).toBe(true);
		const result = await reapRun({
			runId: ctx.runId,
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
		expect((await ctx.repos.runs.require(ctx.runId)).prUrl).toBe("fake://x/y/pulls/1");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")?.payloadJson).toMatchObject({
			mode: "exists",
		});
	});

	test("emits reap_failed step=pr_open when the forge open fails (network)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = stubForge({
			openPullRequest: () => Promise.resolve(forgeErr("network", "ECONNREFUSED")),
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.state).toBe("succeeded");
	});
});

describe("runPrOpen semantic retry (warren-70c6; classified kinds warren-45e6)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	const noopSleep = async (_ms: number): Promise<void> => {};

	test("retries a transient conflict and succeeds on second attempt", async () => {
		const e = fakeExec({ revListCount: "2" });
		// transient 422: "head invalid" while GitHub indexes the just-pushed ref
		const open = queuedOpen([
			forgeErr("conflict", "POST /pulls returned 422: Validation Failed errors=[head-invalid]"),
			{ ok: true, value: fakePrRef(32) },
		]);
		const forge = stubForge({ openPullRequest: open.openPullRequest });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
			sleep: noopSleep,
		});
		expect(result.prUrl).toBe("fake://x/y/pulls/32");
		expect(open.calls).toHaveLength(2);
		expect(result.errors.map((x) => x.step)).not.toContain("pr_open");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")).toBeDefined();
	});

	test("exhausts all retries and emits reap_failed when every attempt conflicts", async () => {
		const e = fakeExec({ revListCount: "2" });
		const conflict = forgeErr("conflict", "POST /pulls returned 422: Validation Failed");
		// 1 initial + 3 retries = 4 attempts total
		const open = queuedOpen([conflict, conflict, conflict, conflict]);
		const forge = stubForge({ openPullRequest: open.openPullRequest });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
			sleep: noopSleep,
		});
		expect(result.prUrl).toBeNull();
		expect(open.calls).toHaveLength(4);
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.state).toBe("succeeded"); // run itself still succeeded
	});

	test("a permanent 'No commits between' 422 arrives as a classified conflict and exhausts the budget", async () => {
		const e = fakeExec({ revListCount: "2" });
		// warren-45e6: no message-string re-derivation — the permanent 422 is
		// the same classified `conflict` kind as the transient one, so it rides
		// the same semantic budget and then surfaces as a best-effort failure.
		const permanent = forgeErr(
			"conflict",
			"POST /pulls returned 422: Validation Failed errors=[No commits between main and feature.]",
		);
		const open = queuedOpen([permanent, permanent, permanent, permanent]);
		const forge = stubForge({ openPullRequest: open.openPullRequest });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
			sleep: noopSleep,
		});
		expect(result.prUrl).toBeNull();
		expect(open.calls).toHaveLength(4);
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.errors.find((x) => x.step === "pr_open")?.message).toContain("conflict");
	});

	test("does not retry non-conflict kinds (http_error surfaces immediately)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const open = queuedOpen([forgeErr("http_error", "POST /pulls returned 418: teapot")]);
		const forge = stubForge({ openPullRequest: open.openPullRequest });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
			sleep: noopSleep,
		});
		expect(result.prUrl).toBeNull();
		expect(open.calls).toHaveLength(1); // no retry
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
	});

	test("ci-fixer run self-skips pr_open and emits reap.pr_open_skipped (warren-a993)", async () => {
		const parent = await ctx.repos.runs.require(ctx.runId);
		const fixer = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId: parent.projectId as string,
			prompt: "fix ci",
			renderedAgentJson: {},
			trigger: "ci-fixer",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "run_yyyyyyyyyyyy",
		});
		await ctx.repos.runs.markRunning(fixer.id);
		const forge = fakeForge();
		const result = await reapRun({
			runId: fixer.id,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), {
				fs: fakeFs().fs,
				exec: fakeExec({ revListCount: "1" }).exec,
			}),
			fs: fakeFs().fs,
			exec: fakeExec({ revListCount: "1" }).exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		expect(result.branchPushed).toBe(true);
		expect(result.prUrl).toBeNull();
		expect(forge.store.getPr("x/y", 1)).toBeNull();
		const skipped = (await ctx.repos.events.listByRun(fixer.id)).find(
			(ev) => ev.kind === "reap.pr_open_skipped",
		);
		expect(skipped?.payloadJson).toMatchObject({ reason: "ci_fixer_run" });
	});
});

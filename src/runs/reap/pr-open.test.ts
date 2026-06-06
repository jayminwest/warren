import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpenPullRequestInput, OpenPullRequestResult } from "../pr.ts";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	setup,
} from "./test-helpers.ts";

describe("reapRun pr_open sub-step (warren-f6af)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	function fakeOpenPr(
		responses: ReadonlyArray<OpenPullRequestResult | (() => OpenPullRequestResult)>,
	): {
		openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
		calls: OpenPullRequestInput[];
	} {
		const calls: OpenPullRequestInput[] = [];
		let i = 0;
		const openPr = async (input: OpenPullRequestInput): Promise<OpenPullRequestResult> => {
			calls.push(input);
			const r = responses[i++];
			if (r === undefined) throw new Error("fakeOpenPr: out of responses");
			return typeof r === "function" ? r() : r;
		};
		return { openPr, calls };
	}

	test("opens PR after a successful push with real commits and persists prUrl", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/77");
		expect(pr.calls).toHaveLength(1);
		expect(pr.calls[0]?.owner).toBe("x");
		expect(pr.calls[0]?.repo).toBe("y");
		expect(pr.calls[0]?.head).toBe("agent/refactor-bot/run-1");
		expect(pr.calls[0]?.base).toBe("main");
		expect((await ctx.repos.runs.require(ctx.runId)).prUrl).toBe("https://github.com/x/y/pull/77");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const opened = events.find((ev) => ev.kind === "reap.pr_opened");
		expect(opened?.payloadJson).toMatchObject({
			prUrl: "https://github.com/x/y/pull/77",
			mode: "created",
		});
		const completed = events.find((ev) => ev.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ prUrl: "https://github.com/x/y/pull/77" });
	});

	test("skips pr_open when autoOpenPr is omitted (default off in tests)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")).toBeUndefined();
	});

	test("skips pr_open when autoOpenPr is disabled", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: false, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("skips pr_open when outcome is failed (conservative V1)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("skips pr_open when push lands no commits (commitsAhead === 0)", async () => {
		const e = fakeExec({ revListCount: "0" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("skips pr_open when branch matches project.defaultBranch", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow({ branch: "main" })), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("skips pr_open when push failed", async () => {
		const e = fakeExec({ fail: "remote rejected" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.branchPushed).toBe(false);
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("emits reap_failed step=pr_open when token is missing but auto-open enabled", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(pr.calls).toHaveLength(0);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const failed = events.find(
			(ev) =>
				ev.kind === "reap_failed" &&
				typeof ev.payloadJson === "object" &&
				ev.payloadJson !== null &&
				(ev.payloadJson as { step?: string }).step === "pr_open",
		);
		expect(failed).toBeDefined();
	});

	test("treats 'pr already exists' (mode=exists) as success and persists the existing url", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/3", mode: "exists" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/3");
		expect(result.errors.map((x) => x.step)).not.toContain("pr_open");
		expect((await ctx.repos.runs.require(ctx.runId)).prUrl).toBe("https://github.com/x/y/pull/3");
	});

	test("emits reap_failed step=pr_open when openPr returns network error", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: false, reason: "network", message: "ECONNREFUSED" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.state).toBe("succeeded");
	});
});

describe("runPrOpen retry (warren-70c6)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	function fakeOpenPr(
		responses: ReadonlyArray<OpenPullRequestResult | (() => OpenPullRequestResult)>,
	): {
		openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
		calls: OpenPullRequestInput[];
	} {
		const calls: OpenPullRequestInput[] = [];
		let i = 0;
		const openPr = async (input: OpenPullRequestInput): Promise<OpenPullRequestResult> => {
			calls.push(input);
			const r = responses[i++];
			if (r === undefined) throw new Error("fakeOpenPr: out of responses");
			return typeof r === "function" ? r() : r;
		};
		return { openPr, calls };
	}

	const noopSleep = async (_ms: number): Promise<void> => {};

	test("retries transient 422 and succeeds on second attempt", async () => {
		const e = fakeExec({ revListCount: "2" });
		const transient422: OpenPullRequestResult = {
			ok: false,
			reason: "http_error",
			// transient 422: "head invalid" while GitHub indexes the just-pushed ref
			message: "Validation Failed errors=[head-invalid]",
		};
		const success: OpenPullRequestResult = {
			ok: true,
			url: "https://github.com/x/y/pull/32",
			mode: "created",
		};
		const pr = fakeOpenPr([transient422, success]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			sleep: noopSleep,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/32");
		expect(pr.calls).toHaveLength(2);
		expect(result.errors.map((x) => x.step)).not.toContain("pr_open");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")).toBeDefined();
	});

	test("retries 5xx and succeeds on third attempt", async () => {
		const e = fakeExec({ revListCount: "2" });
		const err5xx: OpenPullRequestResult = {
			ok: false,
			reason: "http_error",
			message: "POST /pulls returned 503: Service Unavailable",
		};
		const success: OpenPullRequestResult = {
			ok: true,
			url: "https://github.com/x/y/pull/33",
			mode: "created",
		};
		const pr = fakeOpenPr([err5xx, err5xx, success]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			sleep: noopSleep,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/33");
		expect(pr.calls).toHaveLength(3);
		expect(result.errors.map((x) => x.step)).not.toContain("pr_open");
	});

	test("exhausts all retries and emits reap_failed when every attempt fails", async () => {
		const e = fakeExec({ revListCount: "2" });
		const transient422: OpenPullRequestResult = {
			ok: false,
			reason: "http_error",
			message: "Validation Failed errors=[head-invalid]",
		};
		// 1 initial + 3 retries = 4 attempts total
		const pr = fakeOpenPr([transient422, transient422, transient422, transient422]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			sleep: noopSleep,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(4);
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.state).toBe("succeeded"); // run itself still succeeded
	});

	test("does not retry permanent 422 (no commits between)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const permanent422: OpenPullRequestResult = {
			ok: false,
			reason: "http_error",
			message: "Validation Failed errors=[No commits between main and feature.]",
		};
		const pr = fakeOpenPr([permanent422]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			sleep: noopSleep,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(1); // no retry
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
	});
});

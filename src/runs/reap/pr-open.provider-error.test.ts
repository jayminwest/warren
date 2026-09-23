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
} from "./test-helpers.ts";

/**
 * The warren-cbd3 outcome gate for the pr_open step: a provider-error run
 * whose finalize already pushed real commits still opens a PR (the work is
 * reviewable on origin), while a zero-commit push keeps the original
 * conservative skip. Split out of `pr-open.test.ts` to keep that file under
 * the 500-line budget; the k8s-shaped variant of the open case lives in
 * `run.provider-error.test.ts`.
 */
const AUTO_OPEN = { enabled: true, token: "ghp_xyz", warrenBaseUrl: null } as const;

/** Append the terminal provider-error `turn_end` signal to the run's event log. */
async function appendProviderErrorEvent(ctx: Ctx): Promise<void> {
	await ctx.repos.events.append({
		runId: ctx.runId,
		sandboxEventSeq: 1,
		ts: new Date().toISOString(),
		kind: "state_change",
		stream: "system",
		payload: {
			type: "turn_end",
			message: { stopReason: "error", errorMessage: "Provider finish_reason: error" },
		},
	});
}

describe("reapRun pr_open provider-error outcome gate (warren-cbd3)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("opens a PR for a provider-error run that already pushed real commits", async () => {
		// The run_03wb2b8crbz6 shape: the provider errored after the commit and
		// push landed. The failed outcome alone must not strand gate-green work
		// on a branch with no PR — the pushed commits are reviewable, so the PR
		// opens and the body labels the provider error.
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		await appendProviderErrorEvent(ctx);
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
		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("provider_error");
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		expect((await ctx.repos.runs.require(ctx.runId)).prUrl).toBe("fake://x/y/pulls/1");
		const body = forge.store.getPr("x/y", 1)?.body;
		expect(body).toContain("- **Outcome:** run ended in a provider error");
		expect(body).toContain("Provider finish_reason: error");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")?.payloadJson).toMatchObject({
			prUrl: "fake://x/y/pulls/1",
			mode: "created",
		});
	});

	test("skips pr_open for a provider-error run whose push landed no commits", async () => {
		// The PR exception keys on real pushed work: a zero-commit push is the
		// bookkeeping-only shape the original gate existed to suppress.
		const e = fakeExec({ revListCount: "0" });
		const forge = fakeForge();
		await appendProviderErrorEvent(ctx);
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
		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("provider_error");
		expect(result.prUrl).toBeNull();
		expect(forge.store.getPr("x/y", 1)).toBeNull();
	});
});

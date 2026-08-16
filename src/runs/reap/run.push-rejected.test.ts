import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PUSH_REJECTED_EVENT } from "../../runtime/push-rejection.ts";
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

/**
 * End-to-end reapRun coverage for the warren-b68d policy-rejection split. Split
 * out of `run.test.ts` to keep that file under the 500-line budget; the parser
 * itself is covered directly in `../../runtime/push-rejection.test.ts`.
 *
 * What these two cases pin is the DISTINCTION. Both pushes fail, both leave the
 * commits unpushed, and before this split both read as `finalize_failed`. Only
 * one of them is an operator's to resolve.
 */
const POLICY_REFUSAL = [
	"remote: error: GH013: Repository rule violations found for refs/heads/warren/run-x.",
	"remote: - GITHUB PUSH PROTECTION",
	"remote:            path: src/redaction/scrub.test.ts:42",
	"remote:        https://github.com/o/r/security/secret-scanning/unblock-secret/abc/",
].join("\n");

const NON_FAST_FORWARD = [
	" ! [rejected]        HEAD -> warren/run-x (non-fast-forward)",
	"error: failed to push some refs to 'https://github.com/o/r.git'",
	"hint: Updates were rejected because the tip of your current branch is behind",
].join("\n");

describe("reapRun policy push rejection (warren-b68d)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	const reap = async (failPush: string) => {
		const f = fakeFs();
		const e = fakeExec({ failPush });
		return await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
		});
	};

	test("a refusal on policy grounds gets its own failure reason", async () => {
		const result = await reap(POLICY_REFUSAL);

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("push_rejected_policy");
		// Same preserve-the-workspace posture as finalize_failed: the commits
		// never reached origin, so destroying the workspace would lose them.
		expect(result.workspaceDestroyed).toBe(false);
	});

	test("the unblock URL and flagged path reach the event stream", async () => {
		await reap(POLICY_REFUSAL);

		// The remediation stops being something an operator greps a raw stderr
		// blob for (run_m6br4vntg007 lost $7.23 of finished work to that).
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const rejected = events.find((ev) => ev.kind === PUSH_REJECTED_EVENT);
		expect(rejected?.payloadJson).toMatchObject({
			unblockUrls: ["https://github.com/o/r/security/secret-scanning/unblock-secret/abc/"],
			locations: ["src/redaction/scrub.test.ts:42"],
		});
	});

	test("a non-fast-forward push stays finalize_failed", async () => {
		const result = await reap(NON_FAST_FORWARD);

		// This one is warren's to fix by rebasing, not the operator's to unblock,
		// so it must NOT pick up the new reason or the remediation event.
		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("finalize_failed");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === PUSH_REJECTED_EVENT)).toBe(false);
	});
});

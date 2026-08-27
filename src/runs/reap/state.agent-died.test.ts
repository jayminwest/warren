/**
 * The watchdog-kill witness classification (warren-7f0b), split from
 * `state.test.ts` to stay under the 500-line file-size budget.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

describe("reapRun failure-reason inference — agent_died (warren-7f0b)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("classifies the stdin_hold_timeout kill witness as agent_died (warren-7f0b)", async () => {
		// The K8s entrypoint's idle watchdog killed the stdin-held harness —
		// the exact incident shape (run_cs5ee3zywvjv): model turns flowed, then
		// the kill witness landed on the system stream. Without this arm the
		// run collapsed into `crashed`, hiding the liveness-guard kill from the
		// operator; the same witness drives the watchdog reconcile net.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "I'll start by reading the file." },
		});
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 2,
			ts: new Date().toISOString(),
			kind: "stdin_hold_timeout",
			stream: "system",
			payload: { idleMs: 1_800_000 },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("agent_died");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("agent_died");
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

/**
 * End-to-end reapRun coverage for the warren-edc3 provider-error safety net.
 * Split out of `run.test.ts` to keep that file under the 500-line budget; the
 * pure classifier is covered directly in `provider-error.test.ts`.
 */
describe("reapRun provider-error safety net (warren-edc3)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("flips a succeeded run to failed when the terminal turn errored", async () => {
		// Burrow sees the agent exit 0 after a 400 "credit balance too low" and
		// marks the run succeeded; the error signal rides the per-turn
		// `turn_end` envelope (stopReason=error + errorMessage nested on
		// `message`), which the in-stream terminal detect (agent_end-keyed,
		// warren-e281) misses. Reap's safety net scans the event log and flips
		// to failed.
		const message =
			'{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API"}}';
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "error", errorMessage: message } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("provider_error");
		expect(result.providerError).toBe(message);
		// No bookkeeping-only PR ships for a provider-error run.
		expect(result.prUrl).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.provider_error")).toMatchObject({
			payloadJson: { message },
		});
		const completed = events.find((ev) => ev.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({
			failureReason: "provider_error",
			providerError: message,
		});
		const run = await ctx.repos.runs.require(ctx.runId);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("provider_error");
	});

	test("does not trip on a run that ended on a normal stop", async () => {
		// Legitimate no-op-code run: ends on a normal `stop`. The provider-error
		// safety net must NOT flip it — that's the false-positive the issue
		// calls out a diff-shape heuristic for producing.
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "stop", content: [] } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("succeeded");
		expect(result.failureReason).toBeNull();
		expect(result.providerError).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.provider_error")).toBeUndefined();
	});

	test("first-turn 400 with no prior output is detected", async () => {
		// run_hj207hyzz8hv shape: the very first turn returned the 400, 0
		// tokens, 0 tool calls. The error turn_end is the only model activity.
		const message =
			'{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API"}}';
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "agent_start" },
		});
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 2,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "error", errorMessage: message } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("provider_error");
	});

	test("a cancelled run is not flipped by a provider error signal", async () => {
		// Don't override a cancelled outcome — the operator's cancel wins.
		const message = "Your credit balance is too low to access the Anthropic API";
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "error", errorMessage: message } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "cancelled",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("cancelled");
		expect(result.failureReason).toBeNull();
		expect(result.providerError).toBeNull();
	});
});

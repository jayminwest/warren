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
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "error", errorMessage: message } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
			autoOpenPr: { enabled: true, warrenBaseUrl: null },
		});

		// warren-4001: the enriched signal prefers the upstream body's own
		// error.message; the raw JSON body rides `upstreamBody`.
		const inner = "Your credit balance is too low to access the Anthropic API";
		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("provider_error");
		expect(result.providerError).toBe(inner);
		// No bookkeeping-only PR ships for a provider-error run.
		expect(result.prUrl).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.provider_error")).toMatchObject({
			payloadJson: { message: inner, upstreamBody: message, httpStatus: null },
		});
		const completed = events.find((ev) => ev.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({
			failureReason: "provider_error",
			providerError: inner,
		});
		const run = await ctx.repos.runs.require(ctx.runId);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("provider_error");
	});

	test("warren-4001: opaque harness message is enriched with envelope + run-row context", async () => {
		// The pl-61a4 shape end-to-end: pi terminalized with the literal
		// "Provider returned error" and the payload must still name the
		// provider/model — the envelope's pair wins, the run row's declared
		// pair (warren-2ede) is the fallback.
		const project = await ctx.repos.projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});
		const run = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_bbbbbbbbbbbb",
			sandboxRunId: "run_yyyyyyyyyyyy",
			provider: "openrouter",
			model: "moonshotai/kimi-k3",
		});
		await ctx.repos.runs.markRunning(run.id);
		await ctx.repos.events.append({
			runId: run.id,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: {
				type: "turn_end",
				message: { stopReason: "error", errorMessage: "Provider returned error" },
			},
		});

		const result = await reapRun({
			runId: run.id,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
			autoOpenPr: { enabled: false, warrenBaseUrl: null },
		});

		expect(result.failureReason).toBe("provider_error");
		expect(result.providerError).toBe(
			"Provider returned error (provider=openrouter, model=moonshotai/kimi-k3)",
		);
		const events = await ctx.repos.events.listByRun(run.id);
		expect(events.find((ev) => ev.kind === "reap.provider_error")).toMatchObject({
			payloadJson: {
				message: "Provider returned error (provider=openrouter, model=moonshotai/kimi-k3)",
				provider: "openrouter",
				model: "moonshotai/kimi-k3",
				httpStatus: null,
				upstreamBody: null,
			},
		});
	});

	test("does not trip on a run that ended on a normal stop", async () => {
		// Legitimate no-op-code run: ends on a normal `stop`. The provider-error
		// safety net must NOT flip it — that's the false-positive the issue
		// calls out a diff-shape heuristic for producing.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "stop", content: [] } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
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
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "agent_start" },
		});
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 2,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "error", errorMessage: message } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
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
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "error", errorMessage: message } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "cancelled",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("cancelled");
		expect(result.failureReason).toBeNull();
		expect(result.providerError).toBeNull();
	});

	test("warren-985e: k8s provider_error run surfaces the pod-posted salvage on the terminal record", async () => {
		// The 2026-08-12 incident shape: the run died mid-work on OpenRouter
		// credit exhaustion; the in-pod finalize pushed a ZERO-COMMIT branch
		// (finalize SUCCEEDED, so `finalizeFailed` never fires) but the pod's
		// `empty_push_dirty` salvage window captured the dirty tree and stamped
		// the run row before posting its result. Reap must surface that salvage
		// instead of reporting both fields null with noChanges:false.
		const message =
			'{"type":"error","error":{"type":"invalid_request_error","message":"402: This request requires more credits"}}';
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "turn_end", message: { stopReason: "error", errorMessage: message } },
		});
		const finalizeResult: FinalizeResult = {
			pushed: true,
			commitsAhead: 0,
			emptyPush: true,
			dirty: true,
			dirtyPaths: ["src/runtime/k8s/finalize-entrypoint.salvage.test.ts"],
			workspacePlansBody: null,
			events: [],
			artifacts: {},
			prBranch: null,
			stages: [
				{ stage: "branch_push", status: "ok" },
				{ stage: "commits_ahead", status: "ok" },
			],
		};
		const provider = {
			capabilities: {},
			workspaceInfo: async (): Promise<WorkspaceInfo> => ({
				workspacePath: null,
				branch: "warren/run-1",
			}),
			finalize: async (): Promise<FinalizeResult> => finalizeResult,
			terminate: async () => ({
				archived: true,
				deletedEvents: 0,
				deletedMessages: 0,
				deletedRuns: 0,
			}),
		} as unknown as RuntimeProvider;
		// The pod's salvage POST stamped the row before its result resolved reap.
		await ctx.repos.runs.setSalvage(ctx.runId, {
			rescueRef: "warren/rescue/run-1",
			bundlePath: "/data/salvage/run-1.bundle",
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: provider,
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("provider_error");
		expect(result.salvageRescueRef).toBe("warren/rescue/run-1");
		expect(result.salvagePath).toBe("/data/salvage/run-1.bundle");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const recorded = events.find((ev) => ev.kind === "reap.workspace_salvage_recorded");
		expect(recorded?.payloadJson).toMatchObject({
			source: "pod",
			rescueRef: "warren/rescue/run-1",
			bundlePath: "/data/salvage/run-1.bundle",
		});
		const completed = events.find((ev) => ev.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({
			failureReason: "provider_error",
			salvage: { rescueRef: "warren/rescue/run-1", bundlePath: "/data/salvage/run-1.bundle" },
		});
	});
});

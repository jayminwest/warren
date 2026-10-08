import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	FinalizeResult,
	RunStatus,
	RuntimeProvider,
	WorkspaceInfo,
} from "../../runtime/contract.ts";
import { reapRun } from "./index.ts";
import { type Ctx, fakeExec, fakeFs, setup } from "./test-helpers.ts";

/**
 * End-to-end reapRun coverage for warren-a757: a GKE Spot preemption SIGKILLs
 * the agent (exit 137), the k8s entrypoint synthesizes an error `agent_end`,
 * and reap used to label the run `provider_error` — blaming the model and
 * skipping the infra-lost retry. Reap now asks the runtime first.
 */

const SYNTH_MESSAGE = "agent exited 137 without emitting a terminal envelope";

/** The k8s entrypoint's synthesized terminal for an agent SIGKILLed mid-run. */
async function appendSynthesizedExit(ctx: Ctx, exitCode = 137): Promise<void> {
	await ctx.repos.events.append({
		runId: ctx.runId,
		sandboxEventSeq: 1,
		ts: new Date().toISOString(),
		kind: "agent_killed",
		stream: "system",
		payload: { exitCode, signal: "SIGKILL" },
	});
	await ctx.repos.events.append({
		runId: ctx.runId,
		sandboxEventSeq: 2,
		ts: new Date().toISOString(),
		kind: "state_change",
		stream: "system",
		payload: {
			type: "agent_end",
			synthesized: true,
			reason: "agent_exit_without_terminal_envelope",
			exitCode,
			stopReason: "error",
			errorMessage: `agent exited ${exitCode} without emitting a terminal envelope`,
		},
	});
}

/** A finalize result for a pod that died before posting (nothing pushed). */
function unpostedFinalize(over: Partial<FinalizeResult> = {}): FinalizeResult {
	return {
		pushed: false,
		commitsAhead: null,
		emptyPush: false,
		dirty: false,
		dirtyPaths: [],
		workspacePlansBody: null,
		events: [],
		artifacts: {},
		prBranch: null,
		stages: [],
		...over,
	};
}

function k8sProvider(
	status: RunStatus,
	finalizeResult: FinalizeResult = unpostedFinalize(),
): RuntimeProvider {
	return {
		capabilities: {},
		workspaceInfo: async (): Promise<WorkspaceInfo> => ({
			workspacePath: null,
			branch: "warren/run-1",
		}),
		finalize: async (): Promise<FinalizeResult> => finalizeResult,
		status: async (): Promise<RunStatus> => status,
		terminate: async () => ({
			archived: true,
			deletedEvents: 0,
			deletedMessages: 0,
			deletedRuns: 0,
		}),
	} as unknown as RuntimeProvider;
}

function podStatus(over: Partial<RunStatus>): RunStatus {
	return {
		phase: "failed",
		exitCode: 137,
		lastEventSeq: 0,
		lastEventTs: null,
		exists: true,
		...over,
	};
}

describe("reapRun infra-loss reclassification (warren-a757)", () => {
	let ctx: Ctx;
	let retried: string[];

	beforeEach(async () => {
		ctx = await setup();
		retried = [];
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	async function reap(provider: RuntimeProvider) {
		return reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			runtimeProvider: provider,
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
			onInfraLostRun: async (runId) => {
				retried.push(runId);
			},
		});
	}

	test("a preempted pod lands on preempted, never emits reap.provider_error, and retries", async () => {
		await appendSynthesizedExit(ctx);
		const result = await reap(
			k8sProvider(podStatus({ terminalReason: "preempted", terminalDetail: "DeletionByPodGC" })),
		);

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("preempted");
		expect(result.providerError).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.provider_error")).toBeUndefined();
		expect(events.find((ev) => ev.kind === "reap.infra_loss")?.payloadJson).toMatchObject({
			failureReason: "preempted",
			terminalReason: "preempted",
			agentExitCode: 137,
			terminalDetail: "DeletionByPodGC",
			synthesizedError: SYNTH_MESSAGE,
		});
		expect(events.find((ev) => ev.kind === "reap.completed")?.payloadJson).toMatchObject({
			failureReason: "preempted",
			providerError: null,
		});
		const run = await ctx.repos.runs.require(ctx.runId);
		expect(run.failureReason).toBe("preempted");
		// The infra-lost retry hook fires (its own decision bounds it to one).
		expect(retried).toEqual([ctx.runId]);
	});

	test("a pod that vanished with its node lands on sandbox_run_lost and retries", async () => {
		await appendSynthesizedExit(ctx);
		const result = await reap(
			k8sProvider(podStatus({ exists: false, exitCode: null, terminalReason: "lost" })),
		);
		expect(result.failureReason).toBe("sandbox_run_lost");
		expect(retried).toEqual([ctx.runId]);
	});

	test("a pod still Running on a NotReady node lands on preempted", async () => {
		await appendSynthesizedExit(ctx);
		const result = await reap(
			k8sProvider(podStatus({ phase: "running", exitCode: null, nodeLost: true })),
		);
		expect(result.failureReason).toBe("preempted");
	});

	test("a real OOMKilled container lands on oom_killed (no retry)", async () => {
		await appendSynthesizedExit(ctx);
		const result = await reap(k8sProvider(podStatus({ terminalReason: "oom_killed" })));
		expect(result.failureReason).toBe("oom_killed");
		expect(retried).toEqual([]);
	});

	test("a plain Error exit on a healthy node keeps provider_error", async () => {
		await appendSynthesizedExit(ctx, 1);
		const result = await reap(k8sProvider(podStatus({ exitCode: 1, terminalReason: "error" })));
		expect(result.failureReason).toBe("provider_error");
		expect(result.providerError).toBe("agent exited 1 without emitting a terminal envelope");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.provider_error")).toBeDefined();
		expect(events.find((ev) => ev.kind === "reap.infra_loss")).toBeUndefined();
		expect(retried).toEqual([]);
	});

	test("pushed commits keep provider_error so the landed work is not re-dispatched", async () => {
		await appendSynthesizedExit(ctx);
		const result = await reap(
			k8sProvider(
				podStatus({ terminalReason: "preempted" }),
				unpostedFinalize({
					pushed: true,
					commitsAhead: 2,
					stages: [
						{ stage: "branch_push", status: "ok" },
						{ stage: "commits_ahead", status: "ok" },
					],
				}),
			),
		);
		expect(result.failureReason).toBe("provider_error");
		expect(retried).toEqual([]);
	});

	test("a model-authored provider error keeps provider_error even on a preempted pod", async () => {
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "agent_end", stopReason: "error", errorMessage: "529 overloaded_error" },
		});
		const result = await reap(k8sProvider(podStatus({ terminalReason: "preempted" })));
		expect(result.failureReason).toBe("provider_error");
		expect(retried).toEqual([]);
	});
});

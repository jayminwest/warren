import { describe, expect, test } from "bun:test";
import type { RunHandle, RunStatus } from "../../runtime/contract.ts";
import { classifyInfraLoss, infraLossEventPayload } from "./infra-loss.ts";
import type { ProviderErrorSignal } from "./provider-error.ts";

/**
 * Pure coverage for the warren-a757 reap reclassification: a synthesized
 * agent exit over a substrate the runtime lost lands on an infra cause, while
 * a model-authored provider error keeps `provider_error`.
 */

const HANDLE: RunHandle = { runId: "run_a", sandboxId: "sb_a", providerRunId: "prun_a" };

const SYNTH_137: ProviderErrorSignal = {
	message: "agent exited 137 without emitting a terminal envelope",
	provider: null,
	model: null,
	httpStatus: null,
	upstreamBody: null,
	synthesizedExitCode: 137,
};

const MODEL_ERROR: ProviderErrorSignal = {
	message: "Your credit balance is too low",
	provider: "anthropic",
	model: "claude",
	httpStatus: 400,
	upstreamBody: null,
};

function status(over: Partial<RunStatus>): RunStatus {
	return {
		phase: "failed",
		exitCode: 137,
		lastEventSeq: 0,
		lastEventTs: null,
		exists: true,
		...over,
	};
}

function providerReturning(s: RunStatus | Error): {
	status: (h: RunHandle) => Promise<RunStatus>;
	calls: RunHandle[];
} {
	const calls: RunHandle[] = [];
	return {
		calls,
		status: async (h) => {
			calls.push(h);
			if (s instanceof Error) throw s;
			return s;
		},
	};
}

async function classify(
	s: RunStatus | Error,
	over: {
		signal?: ProviderErrorSignal | null;
		pushedWork?: boolean;
		handle?: RunHandle | null;
	} = {},
) {
	const provider = providerReturning(s);
	const verdict = await classifyInfraLoss({
		provider,
		handle: over.handle === undefined ? HANDLE : over.handle,
		signal: over.signal === undefined ? SYNTH_137 : over.signal,
		pushedWork: over.pushedWork ?? false,
	});
	return { verdict, calls: provider.calls };
}

describe("classifyInfraLoss", () => {
	test("maps a preempted pod under a synthesized 137 exit to preempted", async () => {
		const { verdict, calls } = await classify(
			status({ terminalReason: "preempted", terminalDetail: "DeletionByPodGC" }),
		);
		expect(calls).toEqual([HANDLE]);
		expect(verdict).toEqual({
			failureReason: "preempted",
			terminalReason: "preempted",
			agentExitCode: 137,
			terminalDetail: "DeletionByPodGC",
		});
	});

	test("maps a vanished run to sandbox_run_lost", async () => {
		const { verdict } = await classify(status({ exists: false, terminalReason: "lost" }));
		expect(verdict?.failureReason).toBe("sandbox_run_lost");
	});

	test("maps a vanished run with no terminal reason to sandbox_run_lost", async () => {
		const { verdict } = await classify(status({ exists: false }));
		expect(verdict?.failureReason).toBe("sandbox_run_lost");
	});

	test("maps a vanished preempted pod to preempted", async () => {
		const { verdict } = await classify(status({ exists: false, terminalReason: "preempted" }));
		expect(verdict?.failureReason).toBe("preempted");
	});

	test("maps a still-Running pod on a lost node to preempted", async () => {
		const { verdict } = await classify(
			status({ phase: "running", exitCode: null, nodeLost: true }),
		);
		expect(verdict?.failureReason).toBe("preempted");
		expect(verdict?.terminalReason).toBe("preempted");
	});

	test("maps a real OOMKilled container to oom_killed and an eviction to evicted", async () => {
		expect((await classify(status({ terminalReason: "oom_killed" }))).verdict?.failureReason).toBe(
			"oom_killed",
		);
		expect((await classify(status({ terminalReason: "evicted" }))).verdict?.failureReason).toBe(
			"evicted",
		);
	});

	test("keeps provider_error for a plain Error exit on a healthy node", async () => {
		const { verdict } = await classify(status({ terminalReason: "error" }));
		expect(verdict).toBeNull();
	});

	test("keeps provider_error while the pod still runs on a healthy node", async () => {
		const { verdict } = await classify(status({ phase: "running", exitCode: null }));
		expect(verdict).toBeNull();
	});

	test("never consults the runtime for a model-authored provider error", async () => {
		const { verdict, calls } = await classify(status({ terminalReason: "preempted" }), {
			signal: MODEL_ERROR,
		});
		expect(verdict).toBeNull();
		expect(calls).toHaveLength(0);
	});

	test("never reclassifies once commits were pushed", async () => {
		const { verdict, calls } = await classify(status({ terminalReason: "preempted" }), {
			pushedWork: true,
		});
		expect(verdict).toBeNull();
		expect(calls).toHaveLength(0);
	});

	test("returns null with no signal or no handle", async () => {
		expect(
			(await classify(status({ terminalReason: "preempted" }), { signal: null })).verdict,
		).toBe(null);
		expect(
			(await classify(status({ terminalReason: "preempted" }), { handle: null })).verdict,
		).toBe(null);
	});

	test("fails closed to provider_error when status() throws", async () => {
		const { verdict } = await classify(new Error("api down"));
		expect(verdict).toBeNull();
	});
});

describe("infraLossEventPayload", () => {
	test("names the infra cause and keeps the synthesized message for reference", () => {
		const payload = infraLossEventPayload(
			{
				failureReason: "preempted",
				terminalReason: "preempted",
				agentExitCode: 137,
				terminalDetail: null,
			},
			SYNTH_137.message,
		);
		expect(payload).toMatchObject({
			failureReason: "preempted",
			terminalReason: "preempted",
			agentExitCode: 137,
			synthesizedError: SYNTH_137.message,
		});
		expect(String(payload.message)).toContain("not a provider error");
	});
});

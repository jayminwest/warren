/**
 * Infra-loss reclassification at reap (warren-a757).
 *
 * When an agent process dies without emitting its own terminal envelope, the
 * runtime synthesizes an `agent_end` carrying `stopReason: "error"` and
 * "agent exited N without emitting a terminal envelope" (warren-9a4a). Reap's
 * provider-error safety net (`./provider-error.ts`) then reads that as a model
 * failure and labels the run `provider_error`. That is wrong when the
 * SUBSTRATE killed the agent: a GKE Spot node reclaimed under the pod SIGKILLs
 * the agent (exit 137), and the run should land on an infra-lost cause the
 * infra-lost retry (`../retry/infra-lost-retry.ts`) re-dispatches — not on
 * `provider_error`, which blames the model, pollutes analytics and the judge,
 * and only reaches the provider retry's "not transient" skip.
 *
 * This module asks the runtime, after the reap pipeline has given the pod
 * time to settle, how the run actually ended. Only a SYNTHESIZED exit is
 * eligible — a model-authored error envelope is a real provider error and
 * keeps its label. The runtime's verdict maps:
 *
 *   | runtime status                              | failure_reason     |
 *   |---------------------------------------------|--------------------|
 *   | `preempted` (node reclaimed / disrupted)    | `preempted`        |
 *   | non-terminal phase with `nodeLost`          | `preempted`        |
 *   | absent run (`exists:false`) / `lost`        | `sandbox_run_lost` |
 *   | `evicted`                                   | `evicted`          |
 *   | `oom_killed` (`terminated.reason` OOMKilled) | `oom_killed`       |
 *   | anything else (`error`, still running, …)   | keep provider_error |
 *
 * `preempted` and `sandbox_run_lost` are both infra-lost causes, so the
 * existing single-retry budget (retry-of link, cumulative cost cap, plan-run
 * children deferred to the coordinator's `MAX_CHILD_RETRIES`) bounds the
 * re-dispatch — nothing here widens it.
 *
 * A run whose branch already PUSHED commits is never reclassified: the work landed
 * (and may already have a PR), so an automatic re-dispatch would duplicate
 * it. A `status()` probe failure is likewise a no-op — fail closed to the
 * pre-warren-a757 label rather than guess.
 */

import type { RunFailureReason } from "../../db/schema.ts";
import type {
	RunHandle,
	RunStatus,
	RuntimeProvider,
	TerminalReason,
} from "../../runtime/contract.ts";
import type { ProviderErrorSignal } from "./provider-error.ts";

/** Event kind reap emits in place of `reap.provider_error` for a reclassified run. */
export const REAP_INFRA_LOSS_KIND = "reap.infra_loss";

/** Runtime terminal reasons that name a substrate loss, and their domain cause. */
const INFRA_TERMINAL_TO_FAILURE: Partial<Record<TerminalReason, RunFailureReason>> = {
	preempted: "preempted",
	lost: "sandbox_run_lost",
	evicted: "evicted",
	oom_killed: "oom_killed",
};

/** The runtime's verdict that the substrate, not the model, ended the run. */
export interface InfraLossVerdict {
	readonly failureReason: RunFailureReason;
	/** The runtime's coarse reason behind the verdict (`preempted` for `nodeLost`). */
	readonly terminalReason: TerminalReason;
	/** The agent's exit code off the synthesized envelope (137 on a SIGKILL). */
	readonly agentExitCode: number | null;
	/** The runtime's own detail (e.g. the kubelet message), when it gave one. */
	readonly terminalDetail: string | null;
}

export interface ClassifyInfraLossInput {
	readonly provider: Pick<RuntimeProvider, "status">;
	/** The run's sandbox handle; `null` when the run never got one. */
	readonly handle: RunHandle | null;
	/** Reap's provider-error signal; only a synthesized exit is eligible. */
	readonly signal: ProviderErrorSignal | null;
	/** The pipeline pushed commits (or an unmeasured branch) — never reclassify then. */
	readonly pushedWork: boolean;
}

/**
 * Ask the runtime whether a synthesized-exit "provider error" was really a
 * substrate loss. Returns the verdict, or `null` to keep `provider_error`.
 * Never throws.
 */
export async function classifyInfraLoss(
	input: ClassifyInfraLossInput,
): Promise<InfraLossVerdict | null> {
	const { signal, handle } = input;
	if (signal === null || signal.synthesizedExitCode === undefined) return null;
	if (input.pushedWork || handle === null) return null;
	let status: RunStatus;
	try {
		status = await input.provider.status(handle);
	} catch {
		return null;
	}
	const terminalReason = infraTerminalReason(status);
	if (terminalReason === null) return null;
	const failureReason = INFRA_TERMINAL_TO_FAILURE[terminalReason];
	if (failureReason === undefined) return null;
	return {
		failureReason,
		terminalReason,
		agentExitCode: signal.synthesizedExitCode,
		terminalDetail: status.terminalDetail ?? null,
	};
}

/** The runtime's substrate-loss reason, if its status names one. */
function infraTerminalReason(status: RunStatus): TerminalReason | null {
	if (!status.exists) return status.terminalReason ?? "lost";
	if (status.phase === "failed" && status.terminalReason !== undefined) {
		return status.terminalReason;
	}
	// The pod still reads Running/queued, but its node is gone (warren-a757):
	// the kubelet that would flip the phase is the thing that died.
	if (status.phase !== "succeeded" && status.phase !== "cancelled" && status.nodeLost === true) {
		return "preempted";
	}
	return null;
}

/** The `reap.infra_loss` event payload — what reap records instead of blaming the model. */
export function infraLossEventPayload(
	verdict: InfraLossVerdict,
	providerMessage: string | null,
): Record<string, unknown> {
	return {
		failureReason: verdict.failureReason,
		terminalReason: verdict.terminalReason,
		agentExitCode: verdict.agentExitCode,
		terminalDetail: verdict.terminalDetail,
		message:
			`the agent died without a terminal envelope and the runtime reports ` +
			`'${verdict.terminalReason}': an infrastructure loss, not a provider error`,
		synthesizedError: providerMessage,
	};
}

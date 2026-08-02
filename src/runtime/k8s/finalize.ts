/**
 * `K8sProvider.finalize` body (pl-829f step 20 / warren-0d35) — the load-bearing
 * §4 seam under pod-per-run.
 *
 * The burrow `LocalProvider` runs finalize host-side over the shared workspace
 * (`../local/finalize.ts`). K8s cannot: the run pod's `emptyDir` is unreachable
 * from the control plane, and `exec()` into the pod was rejected as leaky
 * (`runtime-provider-contract.md` §4). So the reap-equivalent collection runs as
 * a post-agent step INSIDE the pod (`./finalize-entrypoint.ts`); THIS module is
 * the warren-side half that drives it:
 *
 *   1. Project the neutral `FinalizeIntent` onto the pod wire (drop the host
 *      `projectClonePathHint`, attach the short-lived push credential) and
 *      `register` it with the `FinalizeCoordinator`.
 *   2. The in-pod harness polls `GET /runs/:id/finalize-intent`, runs the
 *      collection, and POSTs a `FinalizeResult` to `POST /runs/:id/finalize-result`;
 *      the endpoint hands it to the coordinator, resolving our await.
 *   3. Race that result against a wall-clock timeout AND a pod terminal-or-gone
 *      probe so a dead/crashed/GC'd pod can never hang reap. The probe fast-fails
 *      the moment the pod vanishes (`exists:false`) OR reaches a terminal phase
 *      (Failed/Succeeded/Cancelled) — in either state the in-pod
 *      finalize-entrypoint can no longer POST, so waiting the full timeout is
 *      pointless (warren-fd08). Timeout / terminal / gone ⇒ a structured FAILED
 *      `FinalizeResult` (not a throw): reap records the stage failures and still
 *      proceeds to `terminate` (contract §6.8 ordering). A genuine
 *      misconfiguration (no coordinator) throws `RuntimeProviderError`.
 *
 * The push credential travels in the intent (fetched over the authenticated
 * callback AFTER the agent exits) rather than the agent container's static env,
 * so a compromised agent never holds it — see the decision note in `provider.ts`.
 */

import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	FinalizeStage,
	RunHandle,
	RunStatus,
} from "../contract.ts";
import { finalizeCommitStage, finalizeMergeStage } from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import type { FinalizeCoordinator } from "./finalize-coordinator.ts";
import type { InPodFinalizeIntent } from "./finalize-wire.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "./finalize-wire.ts";
import { isTerminalPhase } from "./log-stream.ts";

/**
 * Default wall-clock budget for the whole in-pod finalize round-trip (poll the
 * intent → git push → collect deltas → POST the result). Generous: a cold repo
 * push can be slow. Overridable via `WARREN_K8S_FINALIZE_TIMEOUT_MS`.
 */
export const DEFAULT_K8S_FINALIZE_TIMEOUT_MS = 120_000;
/**
 * How often to re-probe `status()` for a vanished OR terminal pod while awaiting
 * the result. Overridable via `WARREN_K8S_FINALIZE_POD_POLL_MS`.
 */
export const DEFAULT_K8S_FINALIZE_POD_POLL_MS = 3_000;

/**
 * Resolve the finalize wall-clock budgets, letting explicit overrides (tests) win
 * over the `WARREN_K8S_FINALIZE_*` env knobs (warren-fd08); a blank/invalid env
 * value falls through to `finalizeK8sRun`'s module defaults. Returns only the keys
 * that resolved so an absent knob leaves the default in place.
 */
export function resolveFinalizeBudgets(
	env: EnvLike,
	over: { timeoutMs: number | undefined; podPollMs: number | undefined },
): { timeoutMs?: number; podPollMs?: number } {
	const positiveInt = (key: string): number | undefined => {
		const raw = env[key]?.trim();
		if (raw === undefined || raw === "") return undefined;
		const n = Number(raw);
		return Number.isInteger(n) && n > 0 ? n : undefined;
	};
	const timeoutMs = over.timeoutMs ?? positiveInt("WARREN_K8S_FINALIZE_TIMEOUT_MS");
	const podPollMs = over.podPollMs ?? positiveInt("WARREN_K8S_FINALIZE_POD_POLL_MS");
	return {
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(podPollMs !== undefined ? { podPollMs } : {}),
	};
}

/** Injectable seams so the finalize race is unit-testable without a cluster. */
export interface K8sFinalizeDeps {
	readonly coordinator: FinalizeCoordinator;
	/** The provider's own `status()` — the pod-gone probe (`exists:false` ⇒ lost). */
	readonly status: (handle: RunHandle) => Promise<RunStatus>;
	/** Optional short-lived git push credential to embed in the served intent. */
	readonly gitToken?: string;
	readonly timeoutMs?: number;
	readonly podPollMs?: number;
	/** Injectable timer (tests drive it without real delays). Defaults to `setTimeout`. */
	readonly setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

/**
 * The stages a FAILED finalize marks, DERIVED from what the intent asked for
 * (warren-357c): a merge stage per artifact key, a commit stage per commit
 * key, and `branch_push` when the intent pushes.
 */
function failedStages(intent: FinalizeIntent): FinalizeStage[] {
	const stages: FinalizeStage[] = intent.artifacts.map(finalizeMergeStage);
	for (const key of new Set(intent.commit ?? intent.artifacts)) {
		stages.push(finalizeCommitStage(key));
	}
	if (intent.push) stages.push("branch_push");
	return stages;
}

/**
 * A structured FAILED `FinalizeResult` — returned (not thrown) when the in-pod
 * finalize could not complete (timeout / pod gone). Every stage the intent asked
 * for is marked `failed` with `message`, and a `reap_failed`-shaped event rides
 * back so reap surfaces it, mirroring how the pipeline folds a finalize failure
 * into `errors[]`. Nothing was pushed and no delta was produced.
 */
export function failedFinalizeResult(
	intent: FinalizeIntent,
	message: string,
	unposted: NonNullable<FinalizeResult["unposted"]>,
): FinalizeResult {
	const stages = failedStages(intent).map((stage) => ({
		stage,
		status: "failed" as const,
		error: message,
	}));
	return {
		pushed: false,
		unposted,
		commitsAhead: null,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [{ kind: "reap_failed", payload: { step: "finalize", message } }],
		artifacts: {},
		prBranch: null,
		stages,
	};
}

/**
 * Commit-gating defaults to the merge set when omitted (parity with
 * LocalProvider). warren-357c: the wire `commit` now ranges over the same
 * opaque artifact keys as `artifacts`, so the set travels verbatim.
 */
function resolveCommit(intent: FinalizeIntent): string[] {
	return [...(intent.commit ?? intent.artifacts)];
}

/** Project the neutral `FinalizeIntent` onto the pod-shaped wire (host path dropped). */
export function toInPodIntent(
	intent: FinalizeIntent,
	gitToken: string | undefined,
): Omit<InPodFinalizeIntent, "attemptId"> {
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		branch: intent.branch,
		push: intent.push,
		artifacts: [...intent.artifacts],
		commit: resolveCommit(intent),
		...(intent.baseBranch !== undefined ? { baseBranch: intent.baseBranch } : {}),
		...(gitToken !== undefined && gitToken !== "" ? { gitToken } : {}),
	};
}

type RaceOutcome =
	| { kind: "result"; result: FinalizeResult }
	| { kind: "timeout" }
	| { kind: "lost"; reason: "gone" | "terminal"; status: RunStatus };

const defaultSetTimer = (fn: () => void, ms: number): { cancel: () => void } => {
	const id = setTimeout(fn, ms);
	return { cancel: () => clearTimeout(id) };
};

/**
 * Classify a `status()` probe into the fast-fail signal it carries, or `null`
 * when the pod is still live. A VANISHED pod (`exists:false`, GC'd) or one in a
 * TERMINAL phase (Failed/Succeeded/Cancelled) can no longer run the in-pod
 * finalize-entrypoint, so its result POST will never arrive (warren-fd08).
 */
function podLostReason(status: RunStatus): "gone" | "terminal" | null {
	if (!status.exists) return "gone";
	if (isTerminalPhase(status.phase)) return "terminal";
	return null;
}

/**
 * The failed-finalize message for a lost pod, by fast-fail reason (warren-cd3b:
 * the terminal case now carries the pod PHASE + the container's terminalReason
 * so an operator can tell an OOM kill (`oom_killed`) apart from an agent crash
 * (`error`) or a completed-but-unposted container (`completed`) instead of one
 * collapsed message for every root cause).
 */
function lostMessage(reason: "gone" | "terminal", status: RunStatus): string {
	if (reason === "gone") return "run pod is gone; in-pod finalize could not run";
	const detail =
		status.terminalReason !== undefined
			? `${status.phase}; ${status.terminalReason}`
			: status.phase;
	// The kubelet's own message (e.g. the ephemeral-storage eviction reason,
	// warren-4a95) survives the pod's GC only if we carry it into this record.
	const kubelet = status.terminalDetail != null ? ` — ${status.terminalDetail}` : "";
	return `run pod reached a terminal phase (${detail}) without posting a finalize result; in-pod finalize could not run${kubelet}`;
}

/**
 * A repeating `status()` probe that resolves the moment the pod is observed
 * terminal-or-gone (see `podLostReason`). Re-polls every `podPollMs` until a
 * fast-fail signal appears or the race settles. Race-safe: a successful result
 * POST is processed in-process by `submit()` — resolving `pending.result`
 * synchronously on HTTP receipt — BEFORE the entrypoint's container exits and the
 * pod can be OBSERVED terminal, so `resultRace` always wins when the POST landed.
 */
function schedulePodProbe(
	deps: K8sFinalizeDeps,
	handle: RunHandle,
	schedule: (fn: () => void, ms: number) => void,
	isSettled: () => boolean,
	podPollMs: number,
): Promise<RaceOutcome> {
	return new Promise((resolve) => {
		const tick = async (): Promise<void> => {
			if (isSettled()) return;
			try {
				const status = await deps.status(handle);
				const reason = podLostReason(status);
				if (!isSettled() && reason !== null) {
					resolve({ kind: "lost", reason, status });
					return;
				}
			} catch {
				// swallow — a transient status error is retried, not treated as lost.
			}
			schedule(() => void tick(), podPollMs);
		};
		schedule(() => void tick(), podPollMs);
	});
}

/**
 * Drive the in-pod finalize and return its `FinalizeResult`. Registers the intent
 * with the coordinator, then races the pod's result POST against a wall-clock
 * timeout and a pod-gone probe; a timeout or lost pod degrades to
 * `failedFinalizeResult` so reap never hangs and still terminates the pod. Every
 * timer/probe is torn down before returning — nothing outlives the call.
 */
export async function finalizeK8sRun(
	handle: RunHandle,
	intent: FinalizeIntent,
	deps: K8sFinalizeDeps,
): Promise<FinalizeResult> {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_K8S_FINALIZE_TIMEOUT_MS;
	const podPollMs = deps.podPollMs ?? DEFAULT_K8S_FINALIZE_POD_POLL_MS;
	const setTimer = deps.setTimer ?? defaultSetTimer;

	const pending = deps.coordinator.register(handle.runId, toInPodIntent(intent, deps.gitToken));

	// Track every scheduled timer so `settle()` can cancel them all — no stray
	// `status()` probe or timeout callback outlives the finalize.
	const timers = new Set<{ cancel: () => void }>();
	let settled = false;
	const settle = (): void => {
		settled = true;
		for (const t of timers) t.cancel();
		timers.clear();
	};
	const schedule = (fn: () => void, ms: number): void => {
		if (settled) return;
		const timer = setTimer(() => {
			timers.delete(timer);
			fn();
		}, ms);
		timers.add(timer);
	};

	const timeout = new Promise<RaceOutcome>((resolve) => {
		schedule(() => resolve({ kind: "timeout" }), timeoutMs);
	});
	// Fast-fail the wall-clock timeout the moment the pod is terminal-or-gone so
	// reap terminalizes in ~podPollMs instead of hanging the full budget (warren-fd08).
	const podTerminalOrGone = schedulePodProbe(deps, handle, schedule, () => settled, podPollMs);
	const resultRace = pending.result.then((result): RaceOutcome => ({ kind: "result", result }));

	try {
		const outcome = await Promise.race([resultRace, timeout, podTerminalOrGone]);
		if (outcome.kind === "result") return outcome.result;
		if (outcome.kind === "lost") {
			return failedFinalizeResult(
				intent,
				lostMessage(outcome.reason, outcome.status),
				outcome.reason === "gone" ? "pod_gone" : "pod_terminal",
			);
		}
		return failedFinalizeResult(
			intent,
			`in-pod finalize timed out after ${timeoutMs}ms`,
			"timeout",
		);
	} finally {
		settle();
		deps.coordinator.abort(handle.runId, pending.attemptId);
	}
}

/** Raise the standard "provider can't satisfy the intent" error (no coordinator wired). */
export function noCoordinatorError(): RuntimeProviderError {
	return new RuntimeProviderError(
		"K8s runtime has no finalize coordinator wired; in-pod finalize is unavailable",
		{
			recoveryHint:
				"the finalize coordinator defaults to the shared singleton (src/runtime/k8s/finalize-coordinator.ts); " +
				"a K8sProvider built with an explicit `finalizeCoordinator: undefined` cannot correlate the in-pod result.",
		},
	);
}

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
 *   3. Race that result against a wall-clock timeout AND a pod-gone probe so a
 *      dead/crashed pod can never hang reap. Timeout or pod-gone ⇒ a structured
 *      FAILED `FinalizeResult` (not a throw): reap records the stage failures and
 *      still proceeds to `terminate` (contract §6.8 ordering). A genuine
 *      misconfiguration (no coordinator) throws `RuntimeProviderError`.
 *
 * The push credential travels in the intent (fetched over the authenticated
 * callback AFTER the agent exits) rather than the agent container's static env,
 * so a compromised agent never holds it — see the decision note in `provider.ts`.
 */

import type {
	FinalizeIntent,
	FinalizeResult,
	FinalizeStage,
	RunHandle,
	RunStatus,
} from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import type { FinalizeCoordinator } from "./finalize-coordinator.ts";
import type { InPodFinalizeIntent } from "./finalize-wire.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "./finalize-wire.ts";

/**
 * Default wall-clock budget for the whole in-pod finalize round-trip (poll the
 * intent → git push → collect deltas → POST the result). Generous: a cold repo
 * push can be slow. Overridable via `WARREN_K8S_FINALIZE_TIMEOUT_MS`.
 */
export const DEFAULT_K8S_FINALIZE_TIMEOUT_MS = 120_000;
/** How often to re-probe `status()` for a vanished pod while awaiting the result. */
export const DEFAULT_K8S_FINALIZE_POD_POLL_MS = 3_000;

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

/** The stages a FAILED finalize marks, derived from what the intent asked for. */
function failedStages(intent: FinalizeIntent): FinalizeStage[] {
	const stages: FinalizeStage[] = [];
	const mirror = new Set(intent.mirror);
	if (mirror.has("mulch")) stages.push("mulch_merge");
	if (mirror.has("seeds")) stages.push("seeds_mirror");
	if (mirror.has("plans")) stages.push("plans_mirror");
	if (mirror.has("plot")) stages.push("plot_merge");
	const commit = new Set(intent.commit ?? intent.mirror);
	if (commit.has("plot")) stages.push("plot_commit");
	if (commit.has("seeds")) stages.push("seeds_commit");
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
export function failedFinalizeResult(intent: FinalizeIntent, message: string): FinalizeResult {
	const stages = failedStages(intent).map((stage) => ({
		stage,
		status: "failed" as const,
		error: message,
	}));
	return {
		pushed: false,
		commitsAhead: null,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [{ kind: "reap_failed", payload: { step: "finalize", message } }],
		mirror: {},
		prBranch: null,
		stages,
	};
}

/**
 * Commit-gating defaults to `mirror` when omitted (parity with LocalProvider),
 * but the wire's `commit` only ranges over `plot`/`seeds` — filter the four-value
 * mirror set down so `mulch`/`plans` never leak into a commit list.
 */
function resolveCommit(intent: FinalizeIntent): ("plot" | "seeds")[] {
	if (intent.commit !== undefined) return [...intent.commit];
	return intent.mirror.filter((m): m is "plot" | "seeds" => m === "plot" || m === "seeds");
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
		mirror: [...intent.mirror],
		commit: resolveCommit(intent),
		...(intent.baseBranch !== undefined ? { baseBranch: intent.baseBranch } : {}),
		...(intent.closeSeedId !== undefined ? { closeSeedId: intent.closeSeedId } : {}),
		...(gitToken !== undefined && gitToken !== "" ? { gitToken } : {}),
	};
}

type RaceOutcome =
	| { kind: "result"; result: FinalizeResult }
	| { kind: "timeout" }
	| { kind: "lost" };

const defaultSetTimer = (fn: () => void, ms: number): { cancel: () => void } => {
	const id = setTimeout(fn, ms);
	return { cancel: () => clearTimeout(id) };
};

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
	const podGone = new Promise<RaceOutcome>((resolve) => {
		const tick = async (): Promise<void> => {
			if (settled) return;
			try {
				const s = await deps.status(handle);
				if (!settled && !s.exists) {
					resolve({ kind: "lost" });
					return;
				}
			} catch {
				// swallow — a transient status error is retried, not treated as lost.
			}
			schedule(() => void tick(), podPollMs);
		};
		schedule(() => void tick(), podPollMs);
	});
	const resultRace = pending.result.then((result): RaceOutcome => ({ kind: "result", result }));

	try {
		const outcome = await Promise.race([resultRace, timeout, podGone]);
		if (outcome.kind === "result") return outcome.result;
		if (outcome.kind === "lost") {
			return failedFinalizeResult(intent, "run pod is gone; in-pod finalize could not run");
		}
		return failedFinalizeResult(intent, `in-pod finalize timed out after ${timeoutMs}ms`);
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

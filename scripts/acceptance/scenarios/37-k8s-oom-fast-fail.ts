/**
 * Scenario 37 — K8s OOMKill fast-fail (warren-245d, pl-829f step 25 SHIP;
 * design k8s-migration.md §3.2 + step-4 "verify").
 *
 * Acceptance criterion:
 *   "Dispatch a run with a deliberately tiny memory limit against an agent that
 *    allocates memory; the run reaches a terminal `failed` state with
 *    `failureReason: oom_killed` in SECONDS (kubelet cgroup-v2 enforcement +
 *    pod-watcher ~1-2s latency), NOT the multi-minute watchdog path."
 *
 * This is the whole point of the migration: a runaway run kills its own pod and
 * warren surfaces `oom_killed` immediately (`src/runtime/k8s/status-map.ts`
 * maps `terminated.reason == "OOMKilled"` → `oom_killed`), replacing the burrow-
 * era 45-min heartbeat watchdog as the sole OOM backstop.
 *
 * ## Setup the operator provides (see lib/k8s-target.ts)
 *
 * The `WARREN_ACCEPTANCE_K8S_PROJECT` must carry a `.warren/config.yaml`
 * `resources.limits.memoryMiB` low enough that the dispatched agent's normal
 * startup allocation crosses it (e.g. `16`), so the agent container is
 * OOMKilled shortly after it starts. (Per-run resource overrides are not on the
 * `POST /runs` wire today — warren-aedd threads the limit from project config —
 * so the tiny cap is expressed there.) The agent image must actually run and
 * allocate; against a warren whose agent image is a bare toolchain with no
 * in-pod runner this cannot reach `oom_killed` and the scenario will time out —
 * that is a true negative surfacing the missing runner, not a flake.
 *
 * ## Determinism / self-cleaning
 *
 * Idempotent: dispatches its own run, polls to terminal, and cancels in
 * `finally` (cancel is idempotent + a no-op on an already-terminal run), so a
 * re-run against a long-lived deployment leaves nothing behind.
 */

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";
import { resolveK8sTarget } from "../lib/k8s-target.ts";
import { waitForRunTerminal } from "./lib/poll-helpers.ts";

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly failureReason: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;
/** Outer budget: pod schedule + image pull + start + OOM + watch latency. */
const TERMINAL_DEADLINE_MS = 120_000;

export const scenario: Scenario = {
	id: "37",
	title: "K8s OOMKill fast-fail: a tiny-memory run reaches failed(oom_killed) in seconds",
	// Attaches to an external K8s-backed warren via env; skips otherwise. Declared
	// in-proc so the default harness invocation reaches (and skips) it.
	modes: ["in-proc"],
	async run(ctx) {
		const target = resolveK8sTarget(ctx);
		const { http } = target;

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: target.agentName,
				project: target.projectId,
				prompt: "[scenario-37] allocate memory until the cgroup OOM killer fires",
			},
		});
		const runId = created.run.id;
		assertTrue(
			RUN_ID_PATTERN.test(runId),
			`spawn run.id ${runId} does not match ${RUN_ID_PATTERN}`,
		);
		ctx.logger.info(`scenario-37: dispatched ${runId}; waiting for oom_killed`);

		try {
			const dispatchedAt = Date.now();
			const terminal = await waitForTerminal(http, runId, TERMINAL_DEADLINE_MS);
			const elapsedMs = Date.now() - dispatchedAt;
			ctx.logger.info(
				`scenario-37: ${runId} terminal after ${elapsedMs}ms — state=${terminal.state} reason=${terminal.failureReason}`,
			);

			assertEqual(terminal.state, "failed", "OOM run must terminalize as failed");
			assertEqual(
				terminal.failureReason,
				"oom_killed",
				"kubelet OOMKill must surface as failureReason=oom_killed (status-map.ts), " +
					`not a generic error/timeout (got ${terminal.failureReason})`,
			);
		} finally {
			await safeCancel(http, runId, ctx);
		}
	},
};

async function waitForTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<RunRow> {
	try {
		return await waitForRunTerminal(http, runId, timeoutMs);
	} catch (err) {
		if (err instanceof AcceptanceError) {
			throw new Error(
				`${err.message} If the pod never OOMs, the project's .warren/config.yaml memory limit may be too high, ` +
					"or the agent image has no in-pod runner to allocate memory.",
			);
		}
		throw err;
	}
}

async function safeCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtxLike): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-37: best-effort cancel of ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

interface ScenarioCtxLike {
	readonly logger: { debug(msg: string): void };
}

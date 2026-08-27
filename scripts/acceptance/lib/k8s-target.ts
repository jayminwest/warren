/**
 * Shared env-gate + HTTP client resolver for the K8s-backed acceptance
 * scenarios (37 OOM fast-fail, 38 steer delivery — warren-245d, pl-829f step
 * 25 SHIP).
 *
 * ## Why these scenarios point at an EXTERNAL warren
 *
 * Every other acceptance scenario runs against the harness's own in-proc
 * warren, which is backed by the `LocalProvider` (burrow) — it has no
 * Kubernetes. Validating the K8s runtime needs a real cluster + a warren booted
 * with `WARREN_RUNTIME=k8s`, plus run pods whose init container can clone a
 * repo REACHABLE FROM INSIDE THE CLUSTER (the harness's local git-fixture
 * `insteadOf` rewrites do not reach a pod). None of that can be conjured by the
 * in-proc launcher, so these two scenarios instead attach to an operator-
 * prepared K8s warren over env, mirroring scenario 19's `WARREN_TEST_PG_URL`
 * gate: absent config ⇒ `ScenarioSkipped`, so the default
 * `bun run scripts/acceptance/run.ts` stays green on a stock machine while a
 * K8s CI job / a local `k3d` bring-up lights them up.
 *
 * ## Env contract
 *
 *   - `WARREN_ACCEPTANCE_K8S_URL`     (required) base URL of a running warren
 *                                     booted with `WARREN_RUNTIME=k8s`.
 *   - `WARREN_ACCEPTANCE_K8S_TOKEN`   (optional) bearer; defaults to the
 *                                     harness token `ctx.token`.
 *   - `WARREN_ACCEPTANCE_K8S_PROJECT` (required) id of a project already
 *                                     registered on that warren whose repo the
 *                                     run pod's init container can clone.
 *   - `WARREN_ACCEPTANCE_K8S_AGENT`   (optional) agent name to dispatch;
 *                                     defaults to `claude-code`.
 */

import { type ScenarioCtx, skipScenario } from "./assert.ts";
import { WarrenHttp } from "./http.ts";

export interface K8sTarget {
	readonly http: WarrenHttp;
	readonly baseUrl: string;
	/** Operator bearer — needed to mint run-scoped callback tokens (scenario 38, warren-5a5c). */
	readonly token: string;
	readonly projectId: string;
	readonly agentName: string;
}

/**
 * Resolve the K8s acceptance target from env, or `skipScenario(...)` (a
 * `ScenarioSkipped` throw) when the required knobs are absent. `ctx.token` is
 * the token fallback so a same-token external warren needs only the URL +
 * project.
 */
export function resolveK8sTarget(ctx: ScenarioCtx): K8sTarget {
	const baseUrl = process.env.WARREN_ACCEPTANCE_K8S_URL?.trim();
	if (baseUrl === undefined || baseUrl === "") {
		skipScenario(
			"WARREN_ACCEPTANCE_K8S_URL not set — requires a warren booted with WARREN_RUNTIME=k8s. " +
				"Example: WARREN_ACCEPTANCE_K8S_URL=http://127.0.0.1:8080 " +
				"WARREN_ACCEPTANCE_K8S_PROJECT=proj_xxxx",
		);
	}
	const projectId = process.env.WARREN_ACCEPTANCE_K8S_PROJECT?.trim();
	if (projectId === undefined || projectId === "") {
		skipScenario(
			"WARREN_ACCEPTANCE_K8S_PROJECT not set — a cluster-reachable project must be pre-registered " +
				"on the K8s warren (its repo is cloned by the run pod's init container).",
		);
	}
	const token = process.env.WARREN_ACCEPTANCE_K8S_TOKEN?.trim() || ctx.token;
	const agentName = process.env.WARREN_ACCEPTANCE_K8S_AGENT?.trim() || "claude-code";
	return {
		http: new WarrenHttp({ baseUrl, token }),
		baseUrl,
		token,
		projectId,
		agentName,
	};
}

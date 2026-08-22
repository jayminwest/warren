/**
 * `POST /alerts/heal` — closed-loop alert intake (warren-3db0, Phase 2).
 *
 * Token-gated (the standard bearer gate covers `/alerts`; webhook senders
 * are configured with the bearer in their request headers). Accepts a raw
 * Sentry or Grafana webhook payload, discriminated by `?source=`, and:
 *
 *   1. Normalizes it to one internal `HealAlert` (src/healer/alert.ts).
 *   2. Routes it to a healer-enabled project — static
 *      `healer.projectMapping` first, then the alert's inferred repo vs.
 *      each project's git URL (src/healer/resolve.ts).
 *   3. Runs the per-fingerprint guard rails (cooldown / max-retries) off
 *      prior `heal.dispatched` events (src/healer/dispatch.ts).
 *   4. Dispatches a `healer` run via the same `spawnRun` seam `POST /runs`
 *      and the scheduler use, then stamps a durable `heal.dispatched`
 *      system event on the new run for idempotency + observability.
 *
 * Every non-dispatch outcome returns 200 with `{status:"skipped", reason}`
 * so a misconfigured alert rule doesn't look like a hard failure to the
 * sender's retry logic. A dispatch returns 202 with the new run id.
 */

import { ValidationError } from "../../core/errors.ts";
import type { EventsRepo } from "../../db/repos/events.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import {
	buildHealPrompt,
	checkHealerRole,
	decideHealDispatch,
	HEAL_DISPATCHED_EVENT,
	HEALER_TRIGGER,
	type HealAlert,
	type HealAttemptHistory,
	type HealerSettings,
	type HealProjectCandidate,
	isHealAlertSource,
	normalizeAlert,
	resolveHealProject,
} from "../../healer/index.ts";
import { spawnRun } from "../../runs/index.ts";
import {
	DEFAULT_HEALER_ROLE,
	type LoadedWarrenConfig,
	loadWarrenConfig,
} from "../../warren-config/index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { defaultSpawn, readJsonBody } from "./index.ts";
import { stampRunSystemEvent } from "./stamp-event.ts";

export function healAlertHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const source = ctx.url.searchParams.get("source");
		if (!isHealAlertSource(source)) {
			throw new ValidationError("?source must be 'sentry' or 'grafana'");
		}
		const body = await readJsonBody(ctx);
		const alert = normalizeAlert(source, body);

		const candidates = await gatherCandidates(deps);
		const resolved = resolveHealProject(alert, candidates);
		if (resolved.kind !== "matched") {
			return skipped(resolved.kind === "not_enabled" ? "disabled" : "no_match", alert);
		}

		const settings = resolved.candidate.settings;
		if (settings === undefined) return skipped("disabled", alert);

		// warren-50a7: fail loudly on a misconfigured `healer.role` here, at
		// intake, instead of letting it surface as a bare `agent not found`
		// from deep inside spawnRun after the run row already exists.
		await assertHealerRole(deps, resolved.candidate);

		const history = await computeHealHistory(deps.repos.events, alert.fingerprint);
		const decision = decideHealDispatch({
			settings,
			history,
			now: (deps.now ?? (() => new Date()))(),
		});
		if (decision.kind === "skip") return skipped(decision.reason, alert);

		const runId = await dispatchHealer(deps, resolved.candidate, alert);
		return jsonResponse(202, {
			status: "dispatched",
			runId,
			fingerprint: alert.fingerprint,
			projectId: resolved.candidate.projectId,
			source: alert.source,
		});
	};
}

function skipped(reason: string, alert: HealAlert): Response {
	return jsonResponse(200, {
		status: "skipped",
		reason,
		fingerprint: alert.fingerprint,
		source: alert.source,
	});
}

/**
 * Build the routing candidate list: every project, paired with its
 * resolved `healer` config block. A project whose config fails to load
 * is skipped (it can't have opted in if we can't read its block).
 */
async function gatherCandidates(deps: ServerDeps): Promise<HealProjectCandidate[]> {
	const projects = await deps.repos.projects.listAll();
	const candidates: HealProjectCandidate[] = [];
	for (const project of projects) {
		const loaded = await loadProjectConfig(deps, project.id, project.localPath);
		const healer = loaded.defaults?.healer;
		const settings: HealerSettings | undefined =
			healer !== undefined
				? {
						enabled: healer.enabled,
						maxRetries: healer.maxRetries,
						cooldownMinutes: healer.cooldownMinutes,
					}
				: undefined;
		candidates.push({
			projectId: project.id,
			gitUrl: project.gitUrl,
			localPath: project.localPath,
			settings,
			role: healer?.role ?? DEFAULT_HEALER_ROLE,
			projectMapping: healer?.projectMapping ?? [],
		});
	}
	return candidates;
}

/**
 * Validate the matched project's `healer.role` against the registered
 * agents. Throws a `ValidationError` (400) naming the project, the bad
 * role, and the known agents, so a config typo reads as a config error.
 */
async function assertHealerRole(deps: ServerDeps, candidate: HealProjectCandidate): Promise<void> {
	const agents = await deps.repos.agents.listAll();
	const check = checkHealerRole({
		role: candidate.role,
		projectId: candidate.projectId,
		knownRoles: agents.map((a) => a.name),
	});
	if (check.kind === "unknown_role") throw new ValidationError(check.message);
}

async function loadProjectConfig(
	deps: ServerDeps,
	projectId: string,
	projectPath: string,
): Promise<LoadedWarrenConfig> {
	if (deps.warrenConfigs !== undefined) return deps.warrenConfigs.get(projectId, projectPath);
	return loadWarrenConfig({ projectPath });
}

/**
 * Reconstruct the prior heal-attempt history for a fingerprint from the
 * durable `heal.dispatched` events. warren-55cf: the fingerprint filter and
 * the aggregation both run in SQL, so the max-retries and cooldown gates see
 * every prior attempt for this fingerprint regardless of how many unrelated
 * heal dispatches landed since. The previous shape scanned the 500 most
 * recent rows globally and filtered in JS, which silently reset the cooldown
 * once a busy fleet pushed the fingerprint out of that window.
 */
async function computeHealHistory(
	events: EventsRepo,
	fingerprint: string,
): Promise<HealAttemptHistory> {
	const { count, lastTs } = await events.payloadKeyHistory(
		HEAL_DISPATCHED_EVENT,
		"fingerprint",
		fingerprint,
	);
	return { attempts: count, lastAttemptAt: lastTs };
}

/**
 * Spawn the healer run (same seam as `POST /runs`), register its bridge,
 * and stamp the durable `heal.dispatched` event on the new run. Returns
 * the new run id.
 */
async function dispatchHealer(
	deps: ServerDeps,
	candidate: HealProjectCandidate,
	alert: HealAlert,
): Promise<string> {
	// warren-6c4c: mint the spawn's clone-refresh credential per-spawn through
	// the boot forge (forge-contract.md §4); no config object holds a token.
	const project = await deps.repos.projects.require(candidate.projectId);
	const gitSecret = await mintGitCredential(deps.forge, project.gitUrl);
	const result = await spawnRun({
		repos: deps.repos,
		// warren-245d: dispatch through the resolved runtime provider so the
		// alert auto-heal path honors WARREN_RUNTIME=k8s (else it 503s on burrow).
		runtimeProvider: deps.runtimeProvider,
		agentName: candidate.role,
		projectId: candidate.projectId,
		prompt: buildHealPrompt(alert),
		trigger: HEALER_TRIGGER,
		// warren-9ce3: explicit provenance for the dispatch-context log.
		dispatchOrigin: "healer",
		mode: "batch",
		metadata: { healFingerprint: alert.fingerprint, alertSource: alert.source },
		projectsConfig: deps.projectsConfig,
		projectSpawn: deps.spawn ?? defaultSpawn,
		...(gitSecret !== undefined ? { gitCredential: gitSecret } : {}),
		...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
		...(deps.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
			: {}),
		...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
		...(deps.issueTracker !== undefined ? { issueTracker: deps.issueTracker } : {}),
		...(deps.now !== undefined ? { now: deps.now } : {}),
		logger: deps.logger,
	});
	deps.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id);
	await stampDispatchedEvent(deps, result.run.id, alert);
	return result.run.id;
}

/**
 * Stamp the `heal.dispatched` system event. Fire-and-log — a failed event
 * write must not turn a successful dispatch into a 500, but it does cost
 * idempotency for that fingerprint, so it is logged at error level.
 */
async function stampDispatchedEvent(
	deps: ServerDeps,
	runId: string,
	alert: HealAlert,
): Promise<void> {
	await stampRunSystemEvent(deps, deps.logger, {
		runId,
		kind: HEAL_DISPATCHED_EVENT,
		payload: {
			fingerprint: alert.fingerprint,
			source: alert.source,
			title: alert.title,
		},
		level: "error",
		message: "alerts.heal_event_failed",
	});
}

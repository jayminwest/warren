/**
 * Plan-run creation orchestration (warren-e240 / pl-882c step 8).
 *
 * Moved out of `src/server/handlers/plan-runs.ts` so the HTTP handler
 * reduces to parse → call → render, matching the `spawnRun` / `addProject`
 * single-implementation pattern: the domain owns the logic, the handler
 * (and any future CLI surface) wraps it.
 *
 * The dispatch-time project refresh (warren-6d60, previously
 * `src/server/handlers/dispatch-refresh.ts`) lives here too: `POST
 * /plan-runs` reads seeds/plan state off the project's host clone before it
 * dispatches, so a plan submitted + pushed moments earlier is walked
 * against fresh on-disk state. Gated on the git `spawn` seam being wired:
 * production wires `defaultSpawn`, so the refresh fires; tests leave
 * `spawn` unset and read off their stubbed seeds CLI without a real fetch.
 * Refresh failure propagates so the caller aborts before creating any
 * `plan_runs` row — a stale walk is worse than a clean error (mirrors
 * `spawnRun`).
 *
 * Handler order preserved from warren-f923:
 *   (1) load project; NotFoundError → 404 if missing.
 *   (2) reject when project.hasSeeds is false (ProjectLacksSeedsError).
 *   (3) showPlan; assert plan.status is accepted and at least one open
 *       child exists (PlanHasNoOpenChildrenError).
 *   (4) resolve agent via repos.agents.get from the global registry.
 *   (5/6) persist plan_runs + plan_run_children rows in a single
 *       repo.create call (transactional — a half-inserted PlanRun never
 *       appears to listActive).
 */

import { NotFoundError, ValidationError } from "../core/errors.ts";
import { assertPlanRunPromptTemplate } from "../core/plan-run-prompt.ts";
import type { Repos } from "../db/repos/index.ts";
import type { CreatePlanRunResult } from "../db/repos/plan-runs.ts";
import type { ProjectRow } from "../db/schema.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { refreshProject } from "../projects/index.ts";
import { type SeedsCliDeps, showPlan, showSeed } from "../seeds-cli/index.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { PlanHasNoOpenChildrenError, ProjectLacksSeedsError } from "./errors.ts";

export const PLAN_RUN_ACCEPTED_PLAN_STATUSES = ["approved", "active", "done"] as const;

export interface CreatePlanRunOrchestrationInput {
	readonly projectId: string;
	readonly planId: string;
	readonly agentName: string;
	/**
	 * Operator-supplied prompt template. Must reference the child seed
	 * (warren-b3be), or every child is dispatched with an identical blind
	 * prompt. Absent → the repo default, which already carries the
	 * placeholder.
	 */
	readonly promptTemplate?: string;
	readonly ref?: string;
	readonly providerOverride?: string;
	readonly modelOverride?: string;
	/** warren-a63d: per-child USD spend cap, forwarded to every child dispatch. */
	readonly maxCostUsd?: number;
	readonly dispatcherHandle?: string;

	readonly repos: Repos;
	/** Undefined ⇒ ValidationError — plan-runs require the seeds CLI. */
	readonly seedsCli: SeedsCliDeps | undefined;
	/** Git spawn seam. When wired, the host clone is refreshed before the plan walk (warren-6d60). */
	readonly spawn?: SpawnFn;
	readonly projectsConfig: ProjectsConfig;
	/** Private-repo credential for the host-side refresh fetch (`AutoOpenPrConfig.gitToken`). */
	readonly gitToken?: string;
	readonly warrenConfigs?: WarrenConfigCache;
	/** Test seam — defaults to the live `refreshProject`. */
	readonly refreshProjectFn?: typeof refreshProject;
	readonly now?: () => Date;
}

/**
 * Refresh the project's host clone before the plan walk (warren-6d60).
 * Returns the post-refresh row (`localPath` unchanged, `hasSeeds` /
 * `headSha` possibly moved) so subsequent on-disk reads go through it;
 * returns the input row untouched when the spawn seam is unwired.
 */
async function refreshDispatchProject(
	input: CreatePlanRunOrchestrationInput,
	project: ProjectRow,
): Promise<ProjectRow> {
	if (input.spawn === undefined) return project;
	const refreshed = await (input.refreshProjectFn ?? refreshProject)({
		repo: input.repos.projects,
		config: input.projectsConfig,
		id: project.id,
		token: input.gitToken,
		spawn: input.spawn,
		...(input.ref !== undefined ? { ref: input.ref } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
		...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
	});
	return refreshed.project;
}

/**
 * Create a PlanRun against a seeds plan. The coordinator picks the
 * persisted row up on its next tick; this function only validates and
 * persists.
 */
export async function createPlanRun(
	input: CreatePlanRunOrchestrationInput,
): Promise<CreatePlanRunResult> {
	if (input.promptTemplate !== undefined) assertPlanRunPromptTemplate(input.promptTemplate);

	// (1) project lookup — NotFoundError → 404.
	const project = await input.repos.projects.require(input.projectId);

	// (2) hasSeeds gate.
	if (!project.hasSeeds) {
		throw new ProjectLacksSeedsError(
			`project ${project.id} has no .seeds/ directory; plan-runs are not accepted`,
			{
				recoveryHint: "add a .seeds/ directory to the project clone and refresh",
			},
		);
	}

	const dispatchProject = await refreshDispatchProject(input, project);

	// (3) read the plan via seeds-cli.
	if (input.seedsCli === undefined) {
		throw new ValidationError("seeds CLI is not configured on this warren; plan-runs require sd", {
			recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart",
		});
	}
	const plan = await showPlan(input.seedsCli, dispatchProject.localPath, input.planId);
	if (!(PLAN_RUN_ACCEPTED_PLAN_STATUSES as readonly string[]).includes(plan.status)) {
		throw new ValidationError(
			`plan ${input.planId} is in status '${plan.status}'; plan-runs require one of ${PLAN_RUN_ACCEPTED_PLAN_STATUSES.join(", ")}`,
			{
				recoveryHint: "approve or activate the plan in seeds, then retry POST /plan-runs",
			},
		);
	}
	if (plan.children.length === 0) {
		throw new PlanHasNoOpenChildrenError(
			`plan ${input.planId} has no children; nothing to dispatch`,
			{
				recoveryHint: "run `sd plan submit <seed-id>` to populate the plan's children",
			},
		);
	}
	// Probe every child seed's status — if all are already closed there is
	// nothing to dispatch. Each child is read in parallel since the seeds
	// CLI is shell-out + filesystem read, not network.
	const seedsCli = input.seedsCli;
	const childStatuses = await Promise.all(
		plan.children.map((seedId) =>
			showSeed(seedsCli, dispatchProject.localPath, seedId).then((s) => ({
				seedId,
				status: s.status,
			})),
		),
	);
	const hasOpenChild = childStatuses.some((c) => c.status !== "closed");
	if (!hasOpenChild) {
		throw new PlanHasNoOpenChildrenError(
			`plan ${input.planId} has no open children; every child seed is closed`,
			{
				recoveryHint: "re-open at least one child seed (sd update <id> --status open) and retry",
			},
		);
	}

	// (4) resolve the agent from the global registry.
	const agent = await input.repos.agents.get(input.agentName);
	if (agent === null) {
		throw new NotFoundError(`agent not found: ${input.agentName}`);
	}

	// (5/6) persist.
	return input.repos.planRuns.create({
		planId: input.planId,
		projectId: project.id,
		agentName: agent.name,
		children: plan.children.map((seedId, index) => ({ seq: index + 1, seedId })),
		...(input.promptTemplate !== undefined ? { promptTemplate: input.promptTemplate } : {}),
		...(input.ref !== undefined ? { ref: input.ref } : {}),
		...(input.providerOverride !== undefined ? { providerOverride: input.providerOverride } : {}),
		...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
		...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
		...(input.dispatcherHandle !== undefined ? { dispatcherHandle: input.dispatcherHandle } : {}),
		...(input.now !== undefined ? { now: input.now() } : {}),
	});
}

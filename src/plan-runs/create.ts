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
 *   (2) reject when the git-native tracker lacks .seeds (ProjectLacksTrackerError).
 *   (3) showPlan; assert plan.status is accepted and at least one open
 *       child exists (PlanHasNoOpenChildrenError).
 *   (4) resolve agent via repos.agents.get from the global registry.
 *   (5/6) persist plan_runs + plan_run_children rows in a single
 *       repo.create call (transactional — a half-inserted PlanRun never
 *       appears to listActive).
 */

import { NotFoundError, ValidationError } from "../core/errors.ts";
import { assertPlanRunPromptTemplate } from "../core/plan-run-prompt.ts";
import type { PlanRunSource, PlanStatus } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import type { CreatePlanRunResult } from "../db/repos/plan-runs.ts";
import type { ProjectRow } from "../db/schema.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { refreshProject } from "../projects/index.ts";
import type { IssueTracker, PlanCapableTracker, TrackerContext } from "../tracker/contract.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";
import { PlanHasNoOpenChildrenError, ProjectLacksTrackerError } from "./errors.ts";

export const PLAN_RUN_ACCEPTED_PLAN_STATUSES: readonly PlanStatus[] = [
	"approved",
	"active",
	"done",
];

export interface CreatePlanRunOrchestrationInput {
	readonly projectId: string;
	/**
	 * Tracker plan id (`pl-XXXX`) — the classic form. Mutually exclusive
	 * with `issues`; exactly one of the two must be set (warren-de42).
	 */
	readonly planId?: string;
	/**
	 * warren-de42 (2026-08-04 decision): an explicit ordered issue-id list,
	 * the plan-run form a `supportsPlans: false` tracker can still drive.
	 * `getPlan` is skipped entirely; each id is validated via
	 * `tracker.getIssue` and the child sequence is synthesized in list
	 * order with the same PR-merge gating the plan path uses.
	 */
	readonly issues?: readonly string[];
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
	/** Undefined ⇒ ValidationError — plan-runs require an issue tracker. */
	readonly issueTracker: IssueTracker | undefined;
	/** Git spawn seam. When wired, the host clone is refreshed before the plan walk (warren-6d60). */
	readonly spawn?: SpawnFn;
	readonly projectsConfig: ProjectsConfig;
	/** Private-repo credential for the host-side refresh fetch (minted per-spawn via `mintGitCredential`). */
	readonly gitCredential?: GitSpawnCredential;
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
	tracker: IssueTracker,
	project: ProjectRow,
): Promise<ProjectRow> {
	// Only a git-native tracker reads plan state off the project's host
	// clone, so only it benefits from the pre-walk refresh (warren-2d98). A
	// remote tracker answers from its own host — no clone refresh needed
	// (this is where ROADMAP predicts refreshProjectFn dies; it stays for
	// POST /projects/:id/refresh, which is about the clone, not the tracker).
	if (!tracker.capabilities.isGitNative) return project;
	if (input.spawn === undefined) return project;
	const refreshed = await (input.refreshProjectFn ?? refreshProject)({
		repo: input.repos.projects,
		config: input.projectsConfig,
		id: project.id,
		gitCredential: input.gitCredential,
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

/**
 * Step (3) in isolation: read the plan through the tracker and assert it
 * is dispatchable — plan-capable tracker, accepted status, at least one
 * child. Extracted so `createPlanRun` stays under the cognitive-complexity
 * ceiling (warren-d3a6).
 */
async function readPlanChildIds(
	tracker: IssueTracker,
	ctx: TrackerContext,
	planId: string,
): Promise<readonly string[]> {
	if (!tracker.capabilities.supportsPlans) {
		throw new ValidationError(
			"tracker does not support plans; plan-runs require a plan-capable tracker",
			{
				recoveryHint: "configure a tracker whose issues can be grouped into ordered plans",
			},
		);
	}
	const plan = await (tracker as unknown as PlanCapableTracker).getPlan(ctx, planId);
	if (!PLAN_RUN_ACCEPTED_PLAN_STATUSES.includes(plan.status)) {
		throw new ValidationError(
			`plan ${planId} is in status '${plan.status}'; plan-runs require one of ${PLAN_RUN_ACCEPTED_PLAN_STATUSES.join(", ")}`,
			{
				recoveryHint: "approve or activate the plan in the tracker, then retry POST /plan-runs",
			},
		);
	}
	if (plan.children.length === 0) {
		throw new PlanHasNoOpenChildrenError(`plan ${planId} has no children; nothing to dispatch`, {
			recoveryHint: "run `sd plan submit <seed-id>` to populate the plan's children",
		});
	}
	// Probe every child issue's status — if all are already closed there is
	// nothing to dispatch. Each child is read in parallel; the statuses are
	// normalized onto the neutral IssueStatus vocabulary, so `closed` here
	// covers every tracker's terminal state.
	const childStatuses = await Promise.all(
		plan.children.map((seedId) =>
			tracker.getIssue(ctx, seedId).then((issue) => ({ seedId, status: issue.status })),
		),
	);
	const hasOpenChild = childStatuses.some((c) => c.status !== "closed");
	if (!hasOpenChild) {
		throw new PlanHasNoOpenChildrenError(
			`plan ${planId} has no open children; every child seed is closed`,
			{
				recoveryHint: "re-open at least one child seed (sd update <id> --status open) and retry",
			},
		);
	}
	return plan.children;
}

/**
 * The issues form of step (3): no plan read, no supportsPlans requirement —
 * each id is validated through `tracker.getIssue` (a missing id throws
 * `IssueNotFoundError` → 404) and the statuses drive the same
 * "at least one open child" gate as the plan form.
 */
async function readDispatchableIssues(
	tracker: IssueTracker,
	ctx: TrackerContext,
	issues: readonly string[],
): Promise<readonly string[]> {
	const seen = new Set<string>();
	for (const id of issues) {
		if (id.trim() === "") {
			throw new ValidationError("issues[] entries must be non-empty issue ids");
		}
		if (seen.has(id)) {
			throw new ValidationError(`issues[] contains duplicate id '${id}'`);
		}
		seen.add(id);
	}
	const statuses = await Promise.all(
		issues.map((issueId) =>
			tracker.getIssue(ctx, issueId).then((issue) => ({ issueId, status: issue.status })),
		),
	);
	const hasOpen = statuses.some((s) => s.status !== "closed");
	if (!hasOpen) {
		throw new PlanHasNoOpenChildrenError(
			"every issue in the posted list is closed; nothing to dispatch",
			{
				recoveryHint: "re-open at least one issue in the tracker and retry",
			},
		);
	}
	return issues.map((s) => s);
}

/**
 * warren-de42 form disambiguation + step (3): exactly one of `planId` /
 * `issues` drives the child sequence. The plan form requires a
 * supportsPlans tracker and walks the plan; the issues form validates each
 * posted id via `getIssue` and synthesizes the sequence in list order.
 */
async function readChildSequence(
	tracker: IssueTracker,
	ctx: TrackerContext,
	input: CreatePlanRunOrchestrationInput,
): Promise<{ source: PlanRunSource; planId: string | null; childIds: readonly string[] }> {
	const hasPlanId = input.planId !== undefined && input.planId !== "";
	const hasIssues = input.issues !== undefined;
	if (hasPlanId === hasIssues) {
		throw new ValidationError("exactly one of 'planId' or 'issues' is required", {
			recoveryHint:
				"pass planId for a plan-capable tracker, or issues: [id, ...] for an explicit ordered issue list",
		});
	}
	if (hasIssues && (input.issues?.length ?? 0) === 0) {
		throw new ValidationError("'issues' must contain at least one issue id");
	}
	if (hasPlanId && input.planId !== undefined) {
		return {
			source: "plan",
			planId: input.planId,
			childIds: await readPlanChildIds(tracker, ctx, input.planId),
		};
	}
	return {
		source: "issues",
		planId: null,
		childIds: await readDispatchableIssues(tracker, ctx, input.issues ?? []),
	};
}

/**
 * Steps (1)+(2) in isolation: project lookup + the tracker availability
 * gate. Extracted so `createPlanRun` stays under the cognitive-complexity
 * ceiling (warren-d3a6).
 */
async function requireTrackedProject(
	input: CreatePlanRunOrchestrationInput,
): Promise<{ project: ProjectRow; tracker: IssueTracker }> {
	const project = await input.repos.projects.require(input.projectId);
	const tracker = input.issueTracker;
	if (tracker === undefined) {
		throw new ValidationError(
			"no issue tracker is configured on this warren; plan-runs require one",
			{
				recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart",
			},
		);
	}
	if (tracker.capabilities.isGitNative && !project.hasSeeds) {
		throw new ProjectLacksTrackerError(
			`project ${project.id} has no .seeds/ directory; plan-runs are not accepted`,
			{
				recoveryHint: "add a .seeds/ directory to the project clone and refresh",
			},
		);
	}
	return { project, tracker };
}

export async function createPlanRun(
	input: CreatePlanRunOrchestrationInput,
): Promise<CreatePlanRunResult> {
	if (input.promptTemplate !== undefined) assertPlanRunPromptTemplate(input.promptTemplate);

	const { project, tracker } = await requireTrackedProject(input);

	const dispatchProject = await refreshDispatchProject(input, tracker, project);
	const ctx: TrackerContext = {
		projectId: dispatchProject.id,
		localPath: dispatchProject.localPath,
	};

	// (3) read the child sequence through the tracker — plan form walks the
	// plan; issues form synthesizes the sequence from the posted list.
	const { source, planId, childIds } = await readChildSequence(tracker, ctx, input);

	// (4) resolve the agent from the global registry.
	const agent = await input.repos.agents.get(input.agentName);
	if (agent === null) {
		throw new NotFoundError(`agent not found: ${input.agentName}`);
	}

	// (5/6) persist.
	return input.repos.planRuns.create({
		planId,
		source,
		projectId: project.id,
		agentName: agent.name,
		children: childIds.map((seedId, index) => ({ seq: index + 1, seedId })),
		...(input.promptTemplate !== undefined ? { promptTemplate: input.promptTemplate } : {}),
		...(input.ref !== undefined ? { ref: input.ref } : {}),
		...(input.providerOverride !== undefined ? { providerOverride: input.providerOverride } : {}),
		...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
		...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
		...(input.dispatcherHandle !== undefined ? { dispatcherHandle: input.dispatcherHandle } : {}),
		...(input.now !== undefined ? { now: input.now() } : {}),
	});
}

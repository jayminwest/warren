/**
 * Projects handlers (warren-599c / pl-9088 step 3).
 *
 * Extracted from `handlers/index.ts`. ROUTE_TABLE stays in `index.ts`;
 * shared helpers + `defaultSpawn` are re-imported from the index module.
 */

import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { ProjectRow } from "../../db/schema.ts";
import { ProjectLacksSeedsError } from "../../plan-runs/errors.ts";
import { computeReadyPlans, type ReadyPlanInput } from "../../plan-runs/index.ts";
import {
	addProject,
	deleteProject,
	getProject,
	listProjects,
	refreshProject,
} from "../../projects/index.ts";
import { spawnRun } from "../../runs/index.ts";
import { listPlans, listSeedStatuses, showPlan, showSeed } from "../../seeds-cli/index.ts";
import { buildTriggerSummaries, parseCron, resolveCronPrompt } from "../../triggers/index.ts";
import {
	type CronTrigger,
	type LoadedWarrenConfig,
	loadWarrenConfig,
} from "../../warren-config/index.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { Actor, RouteHandler, ServerDeps } from "../types.ts";
import {
	defaultSpawn,
	optionalString,
	readJsonBody,
	readJsonBodyOrEmpty,
	requireParam,
	requireString,
} from "./index.ts";

/**
 * The project columns a `readPublic`-only spectator sees (warren-4f6c /
 * pl-b82d step 15). An allowlist, so a column added to `projects`
 * tomorrow is absent from the public body until someone classifies it
 * here — see `src/server/projection.ts` for why this is never a denylist.
 *
 * `gitUrl` stays: on a public instance every registered repo is public
 * (enforced by the org allowlist, warren-ce9b), and "which repos does
 * this instance work on" is the whole point of the demo surface.
 */
export const PUBLIC_PROJECT_FIELDS = [
	"id",
	"gitUrl",
	"defaultBranch",
	"addedAt",
	"lastFetchedAt",
	"lastHeadSha",
	"hasSeeds",
] as const satisfies readonly (keyof ProjectRow)[];

/**
 * The complement of `PUBLIC_PROJECT_FIELDS`, spelled out so the
 * classification is a decision on record rather than "whatever fell off
 * the list", and so `public-projections.test.ts` can assert the two
 * partition `ProjectRow`.
 *
 * - `localPath` — an absolute server filesystem path under the projects
 *   root. Pure host-layout disclosure; a spectator has no use for it.
 */
export const REDACTED_PROJECT_FIELDS = [
	"localPath",
] as const satisfies readonly (keyof ProjectRow)[];

/** A project row as a `readPublic`-only caller sees it. */
export type PublicProject = Pick<ProjectRow, (typeof PUBLIC_PROJECT_FIELDS)[number]>;

/**
 * Narrow one project row for `actor`. The operator gets the row
 * untouched, so the public body is provably the operator body minus
 * fields — one construction site, no drift.
 */
function projectProject(row: ProjectRow, actor: Actor | undefined): ProjectRow | PublicProject {
	return isPublicOnly(actor) ? pickFields(row, PUBLIC_PROJECT_FIELDS) : row;
}

export function listProjectsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const rows = await listProjects(deps.repos.projects);
		return jsonResponse(200, { projects: rows.map((row) => projectProject(row, ctx.actor)) });
	};
}

/**
 * `GET /projects/:id` — single-project read (warren-2a89). The body is the
 * bare row, matching the SDK's `getProject(): Promise<ProjectRow>` and the
 * single-project bodies of `POST /projects` / `DELETE /projects/:id`; a
 * `readPublic`-only spectator sees it narrowed through the same
 * `projectProject` projection as `GET /projects`.
 */
export function getProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const row = await getProject(deps.repos.projects, id);
		return jsonResponse(200, projectProject(row, ctx.actor));
	};
}

export function createProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const gitUrl = requireString(body, "gitUrl");
		const defaultBranch = optionalString(body, "defaultBranch");
		// warren-ce9b/0883: the public-instance allowlist is enforced inside
		// `addProject` — the single site the CLI shares — so this handler
		// only forwards it. No-op under `WARREN_AUTH=token`
		// (deps.publicAllowlist is absent).
		const project = await addProject({
			repo: deps.repos.projects,
			config: deps.projectsConfig,
			gitUrl,
			...(deps.publicAllowlist !== undefined ? { publicAllowlist: deps.publicAllowlist } : {}),
			...(defaultBranch !== undefined ? { defaultBranch } : {}),
			// Private-repo credential for the host-side clone (AutoOpenPrConfig.gitToken).
			token: deps.autoOpenPr?.gitToken,
			spawn: defaultSpawn,
		});
		return jsonResponse(201, project);
	};
}

export function deleteProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const row = await deleteProject({
			repo: deps.repos.projects,
			config: deps.projectsConfig,
			id,
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
		});
		return jsonResponse(200, row);
	};
}

export function getProjectWarrenConfigHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// `require` throws NotFoundError → 404 via renderError; the cache
		// only knows ids it's been asked about, so the project lookup has
		// to come first to keep the 404 contract honest.
		const project = await deps.repos.projects.require(id);
		const loaded: LoadedWarrenConfig =
			deps.warrenConfigs !== undefined
				? await deps.warrenConfigs.get(project.id, project.localPath)
				: await loadWarrenConfig({ projectPath: project.localPath });
		return jsonResponse(200, {
			triggers: loaded.triggers,
			defaults: loaded.defaults,
			sourceFile: loaded.sourceFile,
			errors: loaded.errors,
			warnings: loaded.warnings,
		});
	};
}

/**
 * `GET /projects/:id/seeds/:seedId` — single-seed status read
 * (warren-4015 / warren-ea66 acceptance (d) follow-up).
 *
 * Surfaces the same `sd show <id> --json` payload the plan-run coordinator
 * already shells out for (via `showSeed`) so the PlotDetail BatchDispatch
 * dialog can drop closed seeds at confirm time instead of round-tripping
 * a doomed `POST /runs` per attachment. Read-only; no state changes.
 *
 * Gates mirror the plan-run handlers so the wire contract stays uniform:
 *   - project 404 via `projects.require`,
 *   - `hasSeeds` gate (ProjectLacksSeedsError → 400),
 *   - `seedsCli` configured (ValidationError → 400),
 *   - SeedsCliError from `showSeed` bubbles up as 500 — a missing seed
 *     surfaces as the underlying `sd show` failure rather than a special
 *     404, matching the plan-runs / plot-plan-runs status probe posture.
 *
 * Response shape is intentionally narrow (`{id, status, blockedBy}`):
 * the UI only needs `status` for the closed-seed filter and `blockedBy`
 * is cheap to surface for future dependency-aware decisions.
 */
export function getProjectSeedHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const seedId = requireParam(ctx, "seedId");
		const project = await deps.repos.projects.require(id);
		if (!project.hasSeeds) {
			throw new ProjectLacksSeedsError(
				`project ${project.id} has no .seeds/ directory; seed status read is not available`,
				{
					recoveryHint: "add a .seeds/ directory to the project clone and refresh",
				},
			);
		}
		if (deps.seedsCli === undefined) {
			throw new ValidationError(
				"seeds CLI is not configured on this warren; seed status read requires sd",
				{ recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart" },
			);
		}
		const issue = await showSeed(deps.seedsCli, project.localPath, seedId);
		return jsonResponse(200, {
			id: issue.id,
			status: issue.status,
			blockedBy: issue.blockedBy ?? [],
		});
	};
}

/**
 * `GET /projects/:id/seeds/plans` — list a project's seeds plans
 * (warren-9b49 / pl-dfb5 step 3).
 *
 * Shells out to `sd plan list --json` via `listPlans` and returns the
 * wire-lean plan summaries the plan-run dispatch form needs to populate
 * its plan-id selector (no `sections` body). Read-only; no state changes.
 *
 * Gates mirror `getProjectSeedHandler` so the seeds-read contract stays
 * uniform: project 404 via `projects.require`, `hasSeeds` gate
 * (ProjectLacksSeedsError → 400), `seedsCli` configured (ValidationError
 * → 400), and SeedsCliError from `listPlans` bubbles up as 500.
 */
export function listProjectSeedPlansHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const project = await deps.repos.projects.require(id);
		if (!project.hasSeeds) {
			throw new ProjectLacksSeedsError(
				`project ${project.id} has no .seeds/ directory; plan list is not available`,
				{ recoveryHint: "add a .seeds/ directory to the project clone and refresh" },
			);
		}
		if (deps.seedsCli === undefined) {
			throw new ValidationError(
				"seeds CLI is not configured on this warren; plan list requires sd",
				{ recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart" },
			);
		}
		const plans = await listPlans(deps.seedsCli, project.localPath);
		return jsonResponse(200, { plans });
	};
}

/**
 * `GET /projects/:id/ready-plans` — list a project's approved plans that
 * are ready to dispatch (warren-f716 / pl-3fc4 step 4).
 *
 * Read-on-demand composition of existing seeds-cli readers plus the
 * plan-runs dedup query: `listPlans` → filter to `approved` → resolve each
 * approved plan's children via `showPlan` → build the project-wide status
 * map via `listSeedStatuses` → fetch already-dispatched plan ids via
 * `repos.planRuns.listDispatchedPlanIds` → return `{ plans }` from the pure
 * `computeReadyPlans` helper (approved + ≥1 open child + not dispatched).
 *
 * Gates mirror `listProjectSeedPlansHandler`: project 404 via
 * `projects.require`, `hasSeeds` gate (ProjectLacksSeedsError → 400),
 * `seedsCli` configured (ValidationError → 400), and SeedsCliError from
 * any reader bubbles up as 500.
 */
export function listReadyPlansHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const project = await deps.repos.projects.require(id);
		if (!project.hasSeeds) {
			throw new ProjectLacksSeedsError(
				`project ${project.id} has no .seeds/ directory; ready plans are not available`,
				{ recoveryHint: "add a .seeds/ directory to the project clone and refresh" },
			);
		}
		if (deps.seedsCli === undefined) {
			throw new ValidationError(
				"seeds CLI is not configured on this warren; ready plans require sd",
				{ recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart" },
			);
		}
		const seedsCli = deps.seedsCli;
		const allPlans = await listPlans(seedsCli, project.localPath);
		const approved = allPlans.filter((plan) => plan.status === "approved");
		const plans: ReadyPlanInput[] = await Promise.all(
			approved.map(async (plan) => {
				const detail = await showPlan(seedsCli, project.localPath, plan.id);
				return {
					id: plan.id,
					...(plan.name === undefined ? {} : { name: plan.name }),
					status: plan.status,
					children: detail.children,
				};
			}),
		);
		const seedStatusById = await listSeedStatuses(seedsCli, project.localPath);
		const dispatchedPlanIds = new Set(await deps.repos.planRuns.listDispatchedPlanIds(project.id));
		const ready = computeReadyPlans({ plans, seedStatusById, dispatchedPlanIds });
		return jsonResponse(200, { plans: ready });
	};
}

export function getProjectTriggersHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const project = await deps.repos.projects.require(id);
		const loaded: LoadedWarrenConfig =
			deps.warrenConfigs !== undefined
				? await deps.warrenConfigs.get(project.id, project.localPath)
				: await loadWarrenConfig({ projectPath: project.localPath });
		const now = deps.now?.() ?? new Date();
		const summaries = await buildTriggerSummaries({
			projectId: project.id,
			triggers: loaded.triggers ?? [],
			repo: deps.repos.triggers,
			now,
		});
		return jsonResponse(200, {
			triggers: summaries,
			errors: loaded.errors,
		});
	};
}

export function runProjectTriggerHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const triggerId = requireParam(ctx, "triggerId");

		// Project 404 must come before warren-config load so a typo'd
		// project id doesn't end up parsing some other project's YAML.
		const required = await deps.repos.projects.require(id);

		// Refresh the clone BEFORE reading the trigger entry. The cached
		// config snapshot predates spawnRun's internal refresh, so without
		// this the entry (role / prompt / maxCostUsd) could come from an
		// older commit than the project defaults resolved at spawn time —
		// and the entry's cap rides the override tier, so a stale cap would
		// beat freshly-loaded limits. refreshProject invalidates the
		// per-project config cache, making the whole dispatch read one
		// post-refresh snapshot; spawnRun's own refresh then lands on the
		// same commit.
		const refreshed = await (deps.refreshProjectFn ?? refreshProject)({
			repo: deps.repos.projects,
			config: deps.projectsConfig,
			id: required.id,
			token: deps.autoOpenPr?.gitToken,
			spawn: deps.spawn ?? defaultSpawn,
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
		});
		const project = refreshed.project;

		const loaded: LoadedWarrenConfig =
			deps.warrenConfigs !== undefined
				? await deps.warrenConfigs.get(project.id, project.localPath)
				: await loadWarrenConfig({ projectPath: project.localPath });

		const trigger = (loaded.triggers ?? []).find((t): t is CronTrigger => t.id === triggerId);
		if (trigger === undefined) {
			throw new NotFoundError(
				`trigger '${triggerId}' not found in .warren/triggers.yaml for project ${project.id}`,
				{
					recoveryHint:
						"GET /projects/:id/triggers to list the triggers warren parsed from .warren/triggers.yaml",
				},
			);
		}

		const prompt = resolveCronPrompt(trigger, loaded.defaults);
		const now = deps.now?.() ?? new Date();

		const result = await spawnRun({
			repos: deps.repos,
			// warren-245d: dispatch through the resolved runtime provider so the
			// manual-run path honors WARREN_RUNTIME=k8s (else it 503s on burrow).
			runtimeProvider: deps.runtimeProvider,
			agentName: trigger.role,
			projectId: project.id,
			prompt,
			trigger: "manual-trigger",
			// warren-a63d: a manual fire honors the entry's spend cap exactly like
			// a cron fire (src/triggers/dispatch.ts) — same override slot.
			...(trigger.maxCostUsd !== undefined ? { maxCostUsdOverride: trigger.maxCostUsd } : {}),
			metadata: {
				triggerId: trigger.id,
				cron: trigger.cron,
				...(trigger.seed !== undefined ? { seed: trigger.seed } : {}),
			},
			...(deps.now !== undefined ? { now: deps.now } : {}),
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			githubToken: deps.autoOpenPr?.gitToken,
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			...(deps.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
				: {}),
			...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
			logger: ctx.logger,
		});

		// Hand off to the bridge so events start flowing into warren.events —
		// same posture as POST /runs (mx-…).
		deps.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);

		// Stamp the trigger row so the UI shows this manual fire as the most
		// recent dispatch. Roll nextFireAt forward when the cron parses; on
		// parse failure write last/run only so the persisted next-fire isn't
		// silently zeroed.
		const parseInput: { expression: string; timezone?: string } = {
			expression: trigger.cron,
			...(trigger.timezone !== undefined ? { timezone: trigger.timezone } : {}),
		};
		const parsed = parseCron(parseInput);
		if (parsed.ok) {
			await deps.repos.triggers.recordFire({
				projectId: project.id,
				triggerId: trigger.id,
				firedAt: now,
				nextFireAt: parsed.cron.nextRun(now),
				runId: result.run.id,
			});
		} else {
			await deps.repos.triggers.upsert({
				projectId: project.id,
				triggerId: trigger.id,
				lastFiredAt: now.toISOString(),
				lastRunId: result.run.id,
			});
		}

		return jsonResponse(201, {
			run: result.run,
			burrow: { id: result.burrow.id, workspacePath: result.burrow.workspacePath },
		});
	};
}

export function refreshProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const ref = body !== null ? optionalString(body, "ref") : undefined;
		const result = await refreshProject({
			repo: deps.repos.projects,
			config: deps.projectsConfig,
			id,
			...(ref !== undefined ? { ref } : {}),
			// Private-repo credential for the host-side fetch (AutoOpenPrConfig.gitToken).
			token: deps.autoOpenPr?.gitToken,
			spawn: deps.spawn ?? defaultSpawn,
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
		});
		return jsonResponse(200, {
			project: result.project,
			headSha: result.headSha,
			ref: result.ref,
		});
	};
}

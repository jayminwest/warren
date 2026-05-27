/**
 * Projects handlers (warren-599c / pl-9088 step 3).
 *
 * Extracted from `handlers/index.ts`. ROUTE_TABLE stays in `index.ts`;
 * shared helpers + `defaultSpawn` are re-imported from the index module.
 */

import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { ProjectLacksSeedsError } from "../../plan-runs/errors.ts";
import { addProject, deleteProject, listProjects, refreshProject } from "../../projects/index.ts";
import { spawnRun } from "../../runs/index.ts";
import { showSeed } from "../../seeds-cli/index.ts";
import { buildTriggerSummaries, parseCron, resolveCronPrompt } from "../../triggers/index.ts";
import {
	type CronTrigger,
	type LoadedWarrenConfig,
	loadWarrenConfig,
} from "../../warren-config/index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import {
	defaultSpawn,
	optionalString,
	readJsonBody,
	readJsonBodyOrEmpty,
	requireParam,
	requireString,
} from "./index.ts";

export function listProjectsHandler(deps: ServerDeps): RouteHandler {
	return async () => jsonResponse(200, { projects: await listProjects(deps.repos.projects) });
}

export function createProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const gitUrl = requireString(body, "gitUrl");
		const defaultBranch = optionalString(body, "defaultBranch");
		const project = await addProject({
			repo: deps.repos.projects,
			config: deps.projectsConfig,
			gitUrl,
			...(defaultBranch !== undefined ? { defaultBranch } : {}),
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
		const project = await deps.repos.projects.require(id);

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
			burrowClientPool: deps.burrowClientPool,
			agentName: trigger.role,
			projectId: project.id,
			prompt,
			trigger: "manual-trigger",
			metadata: {
				triggerId: trigger.id,
				cron: trigger.cron,
				...(trigger.seed !== undefined ? { seed: trigger.seed } : {}),
			},
			...(deps.now !== undefined ? { now: deps.now } : {}),
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			...(deps.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
				: {}),
			...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
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

/**
 * Handlers for warren's HTTP API (SPEC §8.1).
 *
 * Each handler is a thin envelope around a function in `runs/`,
 * `registry/`, `projects/`, or `db/repos/` — the modules already do
 * validation, state machines, and burrow shell-out, so handlers only
 * shape the wire IO.
 *
 * Streaming surface (`GET /runs/:id/events?follow=1`) bridges
 * `tailRunEvents` onto NDJSON. Cleanup follows the same pattern burrow
 * uses (mx-b3423b): `request.signal` propagates to a per-stream
 * AbortController; the source generator returns cleanly on abort;
 * `ReadableStream.cancel` aborts back into the generator if the consumer
 * cancels first. The events generator already tears down its broker
 * subscription in a `finally`, so no broker entries leak.
 *
 * Spawn (`POST /runs`) registers a fresh bridge against the run via
 * `deps.bridges.start()` so the live tail has events to read. Without
 * this hook the run dispatches into burrow but warren never persists
 * any of its events — a regression Phase 6 would otherwise re-introduce.
 *
 * `POST /agents/refresh` is sync from the wire's POV (the canopy clone +
 * per-prompt render runs to completion before responding). We don't
 * stream progress events; if a refresh starts taking minutes the right
 * answer is to add a Phase 13-style readyz/doctor signal, not to bolt a
 * progress channel onto this route.
 */

import type { Burrow, BurrowKind, BurrowState, HttpBurrowListFilter } from "@os-eco/burrow-cli";
import { withTransportMapping } from "../../burrow-client/client.ts";
import { fanOutAcrossWorkers } from "../../burrow-client/fanout.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import type { AgentRow } from "../../db/schema.ts";
import {
	checkBurrowPoolReachable,
	checkBwrap,
	checkCanopyClean,
	checkCanopyClone,
	checkDatabaseReachable,
	checkPreviewAuthStrength,
	checkPreviewMaxLive,
	checkPreviewPortAllocator,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	type DiagnosticCheck,
} from "../../diagnostics/checks.ts";
import { VERSION } from "../../index.ts";
import { ProjectLacksSeedsError } from "../../plan-runs/errors.ts";
import { isValidPlotIdFormat, PlotIdInvalidError, PlotIdNotFoundError } from "../../plots/index.ts";
import { createRunPreviewsRepo, DEFAULT_MAX_LIVE } from "../../preview/eviction.ts";
import { DEFAULT_PREVIEW_PORT_RANGE, PreviewPortAllocator } from "../../preview/port-allocator.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../../projects/clone.ts";
import { addProject, deleteProject, listProjects, refreshProject } from "../../projects/index.ts";
import { type AgentSource, readAgentSource } from "../../registry/builtins/index.ts";
import { CanopyClient } from "../../registry/canopy.ts";
import {
	type RefreshProjectResult,
	refreshAgentRegistry,
	refreshProjectAgents,
} from "../../registry/refresh.ts";
import { spawnRun } from "../../runs/index.ts";
import { showSeed } from "../../seeds-cli/index.ts";
import { buildTriggerSummaries, parseCron, resolveCronPrompt } from "../../triggers/index.ts";
import {
	type CronTrigger,
	DEFAULT_PREVIEW_MODE,
	type LoadedWarrenConfig,
	loadWarrenConfig,
} from "../../warren-config/index.ts";
import { jsonResponse } from "../response.ts";
import type { Route, RouteContext, RouteHandler, ServerDeps } from "../types.ts";
import {
	cancelPlanRunHandler,
	createPlanRunHandler,
	getPlanRunHandler,
	listPlanRunsHandler,
	streamPlanRunEventsHandler,
} from "./plan-runs.ts";
import { createPlotPlanRunHandler } from "./plot-plan-runs.ts";
import {
	answerPlotQuestionHandler,
	attachPlotHandler,
	changePlotStatusHandler,
	createBrainstormHandler,
	createPlotHandler,
	detachPlotHandler,
	editPlotIntentHandler,
	formalizePlotHandler,
	getPlotHandler,
	getPlotSummaryHandler,
	listPlotsHandler,
	mergePlotPrAttachmentHandler,
	needsAttentionCountHandler,
	renamePlotHandler,
	syncPlotHandler,
} from "./plots.ts";
import {
	cancelRunHandler,
	createRunHandler,
	getRunHandler,
	listCostAnalyticsHandler,
	listRunsHandler,
	postRunMessageHandler,
	previewLoginHandler,
	previewTeardownHandler,
	steerRunHandler,
	streamRunEventsHandler,
} from "./runs.ts";

/**
 * Run a command via `Bun.spawn` and return the SpawnResult shape the
 * registry/projects modules expect. Non-zero exit codes are surfaced to
 * the caller; transport-level failures (binary missing, timeout) bubble
 * as the underlying Error so the call-site error mapper can wrap them.
 */
export const defaultSpawn: SpawnFn = async (
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> => {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer =
		opts.timeoutMs !== undefined && opts.timeoutMs > 0
			? setTimeout(() => proc.kill(), opts.timeoutMs)
			: null;
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (timer !== null) clearTimeout(timer);
	return { stdout, stderr, exitCode: exitCode ?? 0 };
};

/* ----------------------------------------------------------------------- */
/* Body / param parsing                                                     */
/* ----------------------------------------------------------------------- */

export async function readJsonBody(ctx: RouteContext): Promise<Record<string, unknown>> {
	const parsed = await readJsonBodyOrEmpty(ctx);
	if (parsed === null) {
		throw new ValidationError("request body is empty; expected a JSON object");
	}
	return parsed;
}

export async function readJsonBodyOrEmpty(
	ctx: RouteContext,
): Promise<Record<string, unknown> | null> {
	const raw = await ctx.request.text();
	if (raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ValidationError(
			`request body must be JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`field '${key}' is required and must be a non-empty string`);
	}
	return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new ValidationError(`field '${key}' must be a string`);
	}
	return value;
}

export function requireParam(ctx: RouteContext, key: string): string {
	const value = ctx.params[key];
	if (value === undefined || value.length === 0) {
		throw new ValidationError(`route param '${key}' is missing`);
	}
	return value;
}

export function parseBoolean(raw: string | null, label: string): boolean | undefined {
	if (raw === null) return undefined;
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	throw new ValidationError(`${label} must be 'true'/'1' or 'false'/'0'; got '${raw}'`);
}

export function parseNonNegativeInt(raw: string | null, label: string): number | undefined {
	if (raw === null) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
		throw new ValidationError(`${label} must be a non-negative integer; got '${raw}'`);
	}
	return n;
}

/* ----------------------------------------------------------------------- */
/* Agents (§8.1)                                                            */
/* ----------------------------------------------------------------------- */

/**
 * Decorate an `AgentRow` with the `source` provenance so `GET /agents`
 * consumers can distinguish built-ins from library-loaded agents.
 */
function withAgentSource(row: AgentRow): AgentRow & { source: AgentSource } {
	return { ...row, source: readAgentSource(row.renderedJson) };
}

/**
 * Optional `?projectId=` filter (R-03 / pl-fef5 step 6). When set,
 * `listAll` returns global ∪ that project's tier; `resolve` does
 * project-first lookup with global fallback. Empty string is rejected
 * so a typo'd query (`?projectId=`) surfaces instead of silently
 * collapsing to global-only.
 */
/**
 * Validate `plotId` at the dispatch edge (POST /runs, POST /plan-runs).
 * Both inputs are normalized so an undefined / empty string passes
 * through unchanged — "no plot bound" is a first-class shape.
 *
 * Format check is always-on (`isValidPlotIdFormat`). Existence check
 * runs only when `plotResolver` is wired on ServerDeps (production
 * wires it in src/server/main.ts). Test harnesses that omit the
 * resolver get format-only validation, which matches the existing
 * per-Plot handler posture in this file (`deps.plotResolver !==
 * undefined ? ... : null`).
 *
 * warren-bae5 / pl-5310 step 2 — fold-in of warren-a353.
 */
export async function assertPlotIdDispatchable(input: {
	readonly plotId: string | undefined;
	readonly plotResolver?: import("../../plots/index.ts").PlotResolver;
}): Promise<void> {
	const { plotId, plotResolver } = input;
	if (plotId === undefined || plotId === "") return;
	if (!isValidPlotIdFormat(plotId)) {
		throw new PlotIdInvalidError(
			`plot_id ${JSON.stringify(plotId)} is not a valid Plot ID (expected shape: plot-<lower-alphanum>+)`,
			{
				recoveryHint:
					"Plot IDs look like `plot-3e72876d`. Visit /plots to copy the canonical id of an existing Plot.",
			},
		);
	}
	if (plotResolver === undefined) return;
	const owning = await plotResolver.resolve(plotId);
	if (owning === null) {
		throw new PlotIdNotFoundError(`plot_id ${plotId} does not match any known Plot`, {
			recoveryHint: "Verify the Plot exists at /plots, or omit plot_id to dispatch an unbound run.",
		});
	}
}

function parseProjectIdQuery(ctx: RouteContext): string | undefined {
	const raw = ctx.url.searchParams.get("projectId");
	if (raw === null) return undefined;
	if (raw.length === 0) {
		throw new ValidationError("?projectId must be a non-empty string");
	}
	return raw;
}

function listAgents(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const projectId = parseProjectIdQuery(ctx);
		const rows = await deps.repos.agents.listAll(projectId !== undefined ? { projectId } : {});
		return jsonResponse(200, { agents: rows.map(withAgentSource) });
	};
}

function getAgent(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const name = requireParam(ctx, "name");
		const projectId = parseProjectIdQuery(ctx);
		const row =
			projectId !== undefined
				? await deps.repos.agents.resolve(name, { projectId })
				: await deps.repos.agents.get(name);
		if (!row) {
			throw new NotFoundError(`agent not found: ${name}`, {
				recoveryHint: "POST /agents/refresh to re-discover from canopy",
			});
		}
		return jsonResponse(200, withAgentSource(row));
	};
}

/**
 * Per-project refresh error caught by `POST /agents/refresh`'s all-
 * projects loop. Surfaced in the response envelope so the operator
 * can spot a project whose `.canopy/` is misconfigured without
 * tanking the library half of the refresh.
 */
interface ProjectRefreshError {
	readonly projectId: string;
	readonly code: string;
	readonly message: string;
}

/** Per-project refresh outcome used by both the all-projects loop and
 * the per-project route. Mirrors `RefreshProjectResult` but stamped
 * with the post-`withAgentSource` row shape so consumers see the
 * provenance label without a second read. */
type ProjectRefreshOutcome = Omit<RefreshProjectResult, "registered"> & {
	readonly registered: (AgentRow & { source: AgentSource })[];
};

function decorateRefreshResult(result: RefreshProjectResult): ProjectRefreshOutcome {
	return {
		projectId: result.projectId,
		registered: result.registered.map(withAgentSource),
		skipped: result.skipped,
		removed: result.removed,
	};
}

/**
 * Build a `CanopyClient` rooted at a project's working tree so
 * `cn list`/`cn render` resolve against `<projectPath>/.canopy/`.
 * The cn binary defaults to whatever the library tier configured
 * (`canopyConfig.cnBinary`, ultimately `WARREN_CN_BINARY`); without
 * a library configured we fall back to "cn" on PATH.
 */
function projectCanopyClient(deps: ServerDeps, projectPath: string): CanopyClient {
	return CanopyClient.forProjectPath({
		projectPath,
		cnBinary: deps.canopyConfig?.cnBinary ?? "cn",
		// Route project-tier spawns through deps.spawn (when set) so tests
		// can stub `cn list`/`cn render` without touching PATH — same seam
		// `POST /projects/:id/refresh` uses for git.
		spawn: deps.spawn ?? defaultSpawn,
	});
}

function refreshAgents(deps: ServerDeps): RouteHandler {
	return async () => {
		// No canopy library configured (warren-d3e9): refresh has nothing
		// to refresh against. 400 with a friendly hint is more useful than
		// 200-with-empty-arrays — the operator's mental model is "I asked
		// for a refresh, why didn't anything happen". Project-tier refresh
		// is still available via POST /projects/:id/agents/refresh.
		if (deps.canopyConfig === undefined) {
			throw new ValidationError("CANOPY_REPO_URL is not set; nothing to refresh", {
				recoveryHint:
					"set CANOPY_REPO_URL to a canopy agent library to enable refresh — built-in agents are always available without one, and POST /projects/:id/agents/refresh handles project-tier .canopy/",
			});
		}
		const canopyConfig = deps.canopyConfig;
		const client = CanopyClient.forLibrary({ config: canopyConfig, spawn: defaultSpawn });
		const libraryResult = await refreshAgentRegistry({
			client,
			agents: deps.repos.agents,
			cloneOptions: {
				config: canopyConfig,
				spawn: defaultSpawn,
			},
		});

		// After the library pass, scan every project's .canopy/ tier
		// (pl-fef5 acceptance #3). Per-project failures (missing .canopy,
		// malformed prompts, cn binary AWOL inside one project) are
		// collected — one bad project must not poison the batch.
		const projects = await deps.repos.projects.listAll();
		const projectOutcomes: ProjectRefreshOutcome[] = [];
		const projectErrors: ProjectRefreshError[] = [];
		for (const project of projects) {
			try {
				const result = await refreshProjectAgents({
					client: projectCanopyClient(deps, project.localPath),
					agents: deps.repos.agents,
					projectId: project.id,
					projectPath: project.localPath,
				});
				projectOutcomes.push(decorateRefreshResult(result));
			} catch (err) {
				projectErrors.push({
					projectId: project.id,
					code: errorCode(err),
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return jsonResponse(200, {
			clone: libraryResult.clone,
			registered: libraryResult.registered,
			skipped: libraryResult.skipped,
			removed: libraryResult.removed,
			projects: projectOutcomes,
			projectErrors,
		});
	};
}

function refreshProjectAgentsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const project = await deps.repos.projects.require(id);
		const result = await refreshProjectAgents({
			client: projectCanopyClient(deps, project.localPath),
			agents: deps.repos.agents,
			projectId: project.id,
			projectPath: project.localPath,
		});
		return jsonResponse(200, decorateRefreshResult(result));
	};
}

/**
 * Best-effort extraction of a `code` string off an error caught in the
 * all-projects refresh loop. Canopy/Warren errors carry one; arbitrary
 * Errors fall back to a generic label.
 */
function errorCode(err: unknown): string {
	if (err !== null && typeof err === "object" && "code" in err) {
		const code = (err as { code: unknown }).code;
		if (typeof code === "string") return code;
	}
	return "internal_error";
}

/* ----------------------------------------------------------------------- */
/* Projects (§8.1)                                                          */
/* ----------------------------------------------------------------------- */

function listProjectsHandler(deps: ServerDeps): RouteHandler {
	return async () => jsonResponse(200, { projects: await listProjects(deps.repos.projects) });
}

function createProjectHandler(deps: ServerDeps): RouteHandler {
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

function deleteProjectHandler(deps: ServerDeps): RouteHandler {
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

function getProjectWarrenConfigHandler(deps: ServerDeps): RouteHandler {
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
function getProjectSeedHandler(deps: ServerDeps): RouteHandler {
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

function getProjectTriggersHandler(deps: ServerDeps): RouteHandler {
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

function runProjectTriggerHandler(deps: ServerDeps): RouteHandler {
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

function refreshProjectHandler(deps: ServerDeps): RouteHandler {
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

/* ----------------------------------------------------------------------- */
/* Burrows (multi-worker fan-out, warren-14ad / pl-9ba1 step 5)             */
/* ----------------------------------------------------------------------- */

/** Whitelist of `Burrow.kind` values accepted on `?kind=`. `satisfies`
 * keeps the array bound to the union so a value that is not a `BurrowKind`
 * fails tsc; addition of a new kind upstream is silent (won't break the
 * route) and only matters once the operator wants to filter on it. */
const BURROW_KIND_VALUES = ["project", "task"] as const satisfies readonly BurrowKind[];
/** Whitelist of `Burrow.state` values accepted on `?state=`. See the
 * `BURROW_KIND_VALUES` note above for the satisfies pattern. */
const BURROW_STATE_VALUES = [
	"active",
	"stopped",
	"destroyed",
] as const satisfies readonly BurrowState[];

function parseBurrowKind(raw: string | null): BurrowKind | undefined {
	if (raw === null) return undefined;
	if (!(BURROW_KIND_VALUES as readonly string[]).includes(raw)) {
		throw new ValidationError(`kind must be one of ${BURROW_KIND_VALUES.join(", ")}; got '${raw}'`);
	}
	return raw as BurrowKind;
}

function parseBurrowState(raw: string | null): BurrowState | undefined {
	if (raw === null) return undefined;
	if (!(BURROW_STATE_VALUES as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`state must be one of ${BURROW_STATE_VALUES.join(", ")}; got '${raw}'`,
		);
	}
	return raw as BurrowState;
}

/**
 * Fan-out `GET /burrows` (warren-14ad, plan acceptance #4). Calls
 * `http.burrows.list(filter)` against every registered worker via
 * `fanOutAcrossWorkers`, unions the rows, and sorts the wire output by
 * `createdAt` ascending (oldest first; same order operators get from a
 * single-worker `burrow burrows list`).
 *
 * Per-worker rejections do not fail the response: the helper logs a
 * `worker_unreachable` warn line per drop-out and the handler surfaces
 * the same set in a `workerErrors` envelope so consumers see which
 * workers contributed and which fell out. Empty pool → 200 with empty
 * arrays.
 */
function listBurrowsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const kind = parseBurrowKind(ctx.url.searchParams.get("kind"));
		const state = parseBurrowState(ctx.url.searchParams.get("state"));
		const projectRoot = ctx.url.searchParams.get("projectRoot");
		const filter: HttpBurrowListFilter = {
			...(kind !== undefined ? { kind } : {}),
			...(state !== undefined ? { state } : {}),
			...(projectRoot !== null ? { projectRoot } : {}),
		};

		const fan = await fanOutAcrossWorkers(
			deps.burrowClientPool,
			(client) => withTransportMapping(client.config, () => client.http.burrows.list(filter)),
			{ logger: deps.logger, op: "burrows.list" },
		);

		const burrows: Burrow[] = fan.results
			.flatMap((r) => r.value.map((b) => ({ burrow: b, workerName: r.workerName })))
			.sort((a, b) => a.burrow.createdAt.getTime() - b.burrow.createdAt.getTime())
			.map((entry) => entry.burrow);

		const workerErrors = fan.errors.map((e) => ({
			worker: e.workerName,
			message: e.error.message,
		}));

		return jsonResponse(200, { burrows, workerErrors });
	};
}

/**
 * Targeted `GET /burrows/:id` (warren-14ad). Resolves the owning worker
 * via `pool.clientFor({burrowId})` (sticky-by-burrow) and forwards the
 * call. Burrows warren has no placement row for return 404 — they are
 * not warren-managed even if a worker has them on disk. A pinned-but-
 * unreachable worker falls through as `StickyWorkerUnreachableError`
 * (503) rather than silently re-placing on another worker (plan risk #5).
 */
function getBurrowHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast for burrows warren never recorded — `placeForBurrow` would
		// otherwise raise `NoEligibleWorkerError` and the generic 503 mapping
		// would lose the not-found semantics.
		if ((await deps.repos.burrows.get(id)) === null) {
			throw new NotFoundError(`burrow not found: ${id}`, {
				recoveryHint:
					"warren has no placement record for this burrow id; it may belong to another control plane",
			});
		}
		const { client } = await deps.burrowClientPool.clientFor({ burrowId: id });
		const burrow = await withTransportMapping(client.config, () => client.http.burrows.get(id));
		return jsonResponse(200, burrow);
	};
}

/* ----------------------------------------------------------------------- */
/* Workers admin (warren-0f0c / pl-9ba1 step 6)                             */
/* ----------------------------------------------------------------------- */

/**
 * `GET /workers` — list every worker warren knows about with its current
 * probe-derived state. Operator-facing: shows whether the pool is healthy,
 * which workers are draining, and surfaces drift between `workers` rows
 * and pool registration so the operator can spot a missing `[workers]`
 * config entry.
 */
function listWorkersHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		const rows = await deps.repos.workers.listAll();
		const registered = new Set(deps.burrowClientPool.names());
		const workers = rows.map((row) => ({
			name: row.name,
			url: row.url,
			state: row.state,
			addedAt: row.addedAt,
			registered: registered.has(row.name),
		}));
		return jsonResponse(200, { workers });
	};
}

/**
 * `POST /workers/:name/drain` — flip warren's drain bit for the named
 * worker. Two side effects, in order:
 *
 *   1. Issue `POST /admin/drain {drain: <body.drain>}` against the burrow
 *      worker so its own dispatcher rejects new `POST /burrows` /
 *      `POST /burrows/:id/runs` with 503 `worker_draining`. This is the
 *      authoritative state on the burrow side; in-flight runs and
 *      streaming reads keep working.
 *   2. Update warren's `workers.state` so placement (`placeForProject`)
 *      skips this worker for new burrows. Setting `drain: true` flips
 *      the row to `draining`; setting `drain: false` flips it back to
 *      `healthy` (the probe loop reconciles to `unreachable` if the
 *      worker is actually down).
 *
 * Failure mode: if the burrow call fails (older burrow without
 * `/admin/drain`, network blip, auth mismatch), the error bubbles up
 * unchanged and warren's row is NOT touched — operators retry once
 * burrow is reachable, rather than warren silently drifting from the
 * worker's actual state.
 */
function drainWorkerHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const name = requireParam(ctx, "name");
		const body = await readJsonBodyOrEmpty(ctx);
		const drain = body !== null ? parseDrainFlag(body) : true;

		const row = await deps.repos.workers.require(name);
		const client = deps.burrowClientPool.get(row.name);

		await withTransportMapping(client.config, () => client.setDrain(drain));

		const nextState = drain ? "draining" : "healthy";
		const updated = await deps.repos.workers.setState(row.name, nextState);
		return jsonResponse(200, {
			name: updated.name,
			state: updated.state,
			drain,
		});
	};
}

/**
 * Parse the optional `drain` body flag. Defaults to `true` when the
 * body is empty (the common case — operators want a one-shot drain
 * with no body). An explicit `false` un-drains.
 */
function parseDrainFlag(body: Record<string, unknown>): boolean {
	const raw = body.drain;
	if (raw === undefined) return true;
	if (typeof raw !== "boolean") {
		throw new ValidationError("field 'drain' must be a boolean");
	}
	return raw;
}

/* ----------------------------------------------------------------------- */
/* Meta (/healthz, /readyz)                                                 */
/* ----------------------------------------------------------------------- */

function healthz(): RouteHandler {
	return () => jsonResponse(200, { ok: true });
}

function version(): RouteHandler {
	return () => jsonResponse(200, { version: VERSION });
}

function readyz(deps: ServerDeps): RouteHandler {
	return async () => {
		// SpawnFn is required for the bwrap + canopy_clean probes; main.ts
		// always wires `defaultSpawn`, but the type system keeps it
		// optional so tests don't have to populate it. Fall back to the
		// handler-local `defaultSpawn` to keep the contract live in tests
		// that don't override.
		const spawn: SpawnFn = deps.spawn ?? defaultSpawn;
		// Canopy probes are gated on `CANOPY_REPO_URL` being configured
		// (warren-d3e9). With no library, both probes return informational
		// `ok: true` rather than failing — built-in agents cover the
		// "no library" case and there's no clone to inspect.
		const env: Readonly<Record<string, string | undefined>> =
			deps.canopyConfig !== undefined
				? {
						CANOPY_REPO_URL: deps.canopyConfig.repoUrl,
						WARREN_CANOPY_DIR: deps.canopyConfig.localDir,
						WARREN_GIT_BINARY: deps.canopyConfig.gitBinary,
					}
				: {};

		const checks: DiagnosticCheck[] = [];
		checks.push(
			await checkDatabaseReachable({ ...(deps.db !== undefined ? { db: deps.db } : {}) }),
		);
		checks.push(await checkBurrowPoolReachable(deps.burrowClientPool));
		checks.push(await checkAgentsRegistered(deps));
		checks.push(checkCanopyClone({ env }));
		checks.push(await checkCanopyClean({ env, spawn }));
		checks.push(await checkBwrap({ spawn }));
		const warrenConfigProjects = (await deps.repos.projects.listAll()).map((p) => ({
			id: p.id,
			localPath: p.localPath,
		}));
		const warrenConfigArgs = {
			projects: warrenConfigProjects,
			...(deps.warrenConfigs !== undefined ? { cache: deps.warrenConfigs } : {}),
		};
		checks.push(await checkWarrenConfig(warrenConfigArgs));
		checks.push(await checkWarrenConfigDeprecations(warrenConfigArgs));
		checks.push(await previewPortAllocatorReadyzCheck(deps));
		checks.push(await previewMaxLiveReadyzCheck(deps));
		// Auth-strength probe (R-19 / SPEC §11.L, warren-8a10) reads from
		// process.env directly: server boot already validated the token shape,
		// so /readyz only needs to surface the strength heuristic against the
		// live env. Tests that don't override `process.env` get the inert
		// "preview disabled" branch.
		checks.push(checkPreviewAuthStrength({ env: process.env }));

		const allOk = checks.every((c) => c.ok);
		return jsonResponse(allOk ? 200 : 503, {
			ok: allOk,
			checks,
		});
	};
}

async function previewPortAllocatorReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	// Range is resolved at boot (`ServerDeps.previewPortRange`) so /readyz
	// doesn't re-parse env per request. Tests omit deps.previewPortRange;
	// fall back to defaults so the probe still exercises the codepath.
	const range = deps.previewPortRange ?? DEFAULT_PREVIEW_PORT_RANGE;
	if (deps.db === undefined) {
		return {
			name: "preview_port_allocator",
			ok: true,
			message: `no db handle wired (range ${range.start}-${range.end})`,
		};
	}
	const allocator = new PreviewPortAllocator(DrizzleAdapter.for(deps.db), range);
	return checkPreviewPortAllocator({ probe: allocator });
}

async function previewMaxLiveReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	const maxLive = deps.previewMaxLive ?? DEFAULT_MAX_LIVE;
	if (deps.db === undefined) {
		return {
			name: "preview_max_live",
			ok: true,
			message: `no db handle wired (cap ${maxLive})`,
		};
	}
	const previews = createRunPreviewsRepo(deps.db);
	return checkPreviewMaxLive({
		probe: { count: () => previews.countActivePreviews() },
		maxLive,
	});
}

/**
 * `GET /preview/config` (R-19 / SPEC §11.L path addendum, warren-016d).
 *
 * Surfaces the deployment-wide preview routing mode + optional host so the
 * UI's `PreviewCard` can render the canonical preview URL without having
 * to encode mode-specific shapes itself. The login handshake at
 * `/runs/:id/preview/login` does its own server-side redirect resolution,
 * so this endpoint is purely informational — the UI calls it once and
 * caches indefinitely (mode/host change requires a warren restart).
 *
 * `host` is null when path mode is configured without `WARREN_PREVIEW_HOST`;
 * in that case the UI derives the URL from `window.location.origin`. In
 * subdomain mode `host` is always set (boot rejects subdomain-without-host).
 */
function previewConfigHandler(deps: ServerDeps): RouteHandler {
	return () =>
		jsonResponse(200, {
			mode: deps.previewMode ?? DEFAULT_PREVIEW_MODE,
			host: deps.previewHost ?? null,
		});
}

async function checkAgentsRegistered(deps: ServerDeps): Promise<DiagnosticCheck> {
	const count = (await deps.repos.agents.listAll()).length;
	if (count === 0) {
		// Built-ins seed on boot (warren-d3e9), so an empty registry here
		// means seeding itself failed — an internal problem, not an
		// operator one. Keep the failure but reword the hint accordingly.
		return {
			name: "agents",
			ok: false,
			message: "no agents registered",
			hint:
				deps.canopyConfig !== undefined
					? "POST /agents/refresh against your canopy library, or check the warren server logs for built-in seed errors"
					: "check the warren server logs for built-in seed errors",
		};
	}
	return { name: "agents", ok: true };
}

/* ----------------------------------------------------------------------- */
/* Public API                                                               */
/* ----------------------------------------------------------------------- */

interface RouteEntry {
	readonly method: Route["method"];
	readonly pattern: string;
	readonly build: (deps: ServerDeps) => RouteHandler;
}

const ROUTE_TABLE: readonly RouteEntry[] = [
	{ method: "GET", pattern: "/healthz", build: () => healthz() },
	{ method: "GET", pattern: "/readyz", build: readyz },
	{ method: "GET", pattern: "/version", build: () => version() },

	{ method: "GET", pattern: "/agents", build: listAgents },
	{ method: "POST", pattern: "/agents/refresh", build: refreshAgents },
	{ method: "GET", pattern: "/agents/:name", build: getAgent },

	{ method: "GET", pattern: "/projects", build: listProjectsHandler },
	{ method: "POST", pattern: "/projects", build: createProjectHandler },
	{ method: "GET", pattern: "/projects/:id/warren-config", build: getProjectWarrenConfigHandler },
	{ method: "GET", pattern: "/projects/:id/triggers", build: getProjectTriggersHandler },
	{ method: "GET", pattern: "/projects/:id/seeds/:seedId", build: getProjectSeedHandler },
	{
		method: "POST",
		pattern: "/projects/:id/triggers/:triggerId/run",
		build: runProjectTriggerHandler,
	},
	{ method: "POST", pattern: "/projects/:id/refresh", build: refreshProjectHandler },
	{
		method: "POST",
		pattern: "/projects/:id/agents/refresh",
		build: refreshProjectAgentsHandler,
	},
	{ method: "DELETE", pattern: "/projects/:id", build: deleteProjectHandler },

	{ method: "GET", pattern: "/burrows", build: listBurrowsHandler },
	{ method: "GET", pattern: "/burrows/:id", build: getBurrowHandler },

	{ method: "GET", pattern: "/workers", build: listWorkersHandler },
	{ method: "POST", pattern: "/workers/:name/drain", build: drainWorkerHandler },

	{ method: "GET", pattern: "/analytics/cost", build: listCostAnalyticsHandler },
	{ method: "GET", pattern: "/runs", build: listRunsHandler },
	{ method: "POST", pattern: "/runs", build: createRunHandler },
	{ method: "GET", pattern: "/runs/:id", build: getRunHandler },
	{ method: "GET", pattern: "/runs/:id/events", build: streamRunEventsHandler },
	{ method: "POST", pattern: "/runs/:id/messages", build: postRunMessageHandler },
	{ method: "POST", pattern: "/runs/:id/steer", build: steerRunHandler },
	{ method: "POST", pattern: "/runs/:id/cancel", build: cancelRunHandler },
	{ method: "GET", pattern: "/runs/:id/preview/login", build: previewLoginHandler },
	{ method: "POST", pattern: "/runs/:id/preview/teardown", build: previewTeardownHandler },

	{ method: "GET", pattern: "/preview/config", build: previewConfigHandler },

	{ method: "GET", pattern: "/plan-runs", build: listPlanRunsHandler },
	{ method: "POST", pattern: "/plan-runs", build: createPlanRunHandler },
	{ method: "POST", pattern: "/plot-plan-runs", build: createPlotPlanRunHandler },
	{ method: "GET", pattern: "/plan-runs/:id", build: getPlanRunHandler },
	{ method: "POST", pattern: "/plan-runs/:id/cancel", build: cancelPlanRunHandler },
	{ method: "GET", pattern: "/plan-runs/:id/events", build: streamPlanRunEventsHandler },

	{ method: "POST", pattern: "/brainstorm", build: createBrainstormHandler },
	{ method: "GET", pattern: "/plots", build: listPlotsHandler },
	{ method: "POST", pattern: "/plots", build: createPlotHandler },
	// Static path — must precede `/plots/:id` so the param route doesn't
	// swallow `needs-attention` as an :id.
	{
		method: "GET",
		pattern: "/plots/needs-attention/count",
		build: needsAttentionCountHandler,
	},
	{ method: "POST", pattern: "/plots/:id/formalize", build: formalizePlotHandler },
	// Static-suffix path — must precede `/plots/:id` so the param route
	// doesn't swallow `summary` as the rest of the id.
	{ method: "GET", pattern: "/plots/:id/summary", build: getPlotSummaryHandler },
	{ method: "GET", pattern: "/plots/:id", build: getPlotHandler },
	{ method: "POST", pattern: "/plots/:id/intent", build: editPlotIntentHandler },
	{ method: "POST", pattern: "/plots/:id/rename", build: renamePlotHandler },
	{ method: "POST", pattern: "/plots/:id/sync", build: syncPlotHandler },
	{ method: "POST", pattern: "/plots/:id/status", build: changePlotStatusHandler },
	{ method: "POST", pattern: "/plots/:id/attachments", build: attachPlotHandler },
	// Specific path — must precede `/plots/:id/attachments/:ref` so the
	// DELETE-by-ref route doesn't swallow `<ref>/merge` as a ref.
	{
		method: "POST",
		pattern: "/plots/:id/attachments/:ref/merge",
		build: mergePlotPrAttachmentHandler,
	},
	{
		method: "DELETE",
		pattern: "/plots/:id/attachments/:ref",
		build: detachPlotHandler,
	},
	{
		method: "POST",
		pattern: "/plots/:id/questions/:event_id/answer",
		build: answerPlotQuestionHandler,
	},
];

/**
 * Matches `/runs/<id>/preview/login` (the auth-exempt signed-cookie
 * handshake from SPEC §11.L). Kept module-scoped so the request gate
 * doesn't compile a regex per request.
 */
const PREVIEW_LOGIN_PATH_RE = /^\/runs\/[^/]+\/preview\/login\/?$/;

export function buildApiRoutes(deps: ServerDeps): Route[] {
	return ROUTE_TABLE.map((entry) => ({
		method: entry.method,
		pattern: entry.pattern,
		handler: entry.build(deps),
	}));
}

/**
 * Top-level prefixes the API claims. Any pathname under one of these is
 * an API request: it requires auth (except `/healthz`, see
 * `isAuthExempt`) and the SPA fallback in `ui.ts` refuses to serve
 * `index.html` for it. Kept in sync with `ROUTE_TABLE` by hand — the
 * router patterns are richer than prefixes (`/agents/:name`,
 * `/runs/:id/events`) so we can't derive these without either parsing
 * the patterns or duplicating the policy.
 */
export const API_PREFIXES: readonly string[] = [
	"/agents",
	"/analytics",
	"/brainstorm",
	"/burrows",
	"/projects",
	"/runs",
	"/workers",
	"/healthz",
	"/readyz",
	"/version",
	"/preview",
	"/plan-runs",
	"/plot-plan-runs",
	"/plots",
];

/**
 * True iff `pathname` is one of the API surfaces above. Cheap prefix
 * scan — five entries, no allocations on the hot path.
 */
export function isApiPath(pathname: string): boolean {
	for (const prefix of API_PREFIXES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

/**
 * Auth predicate for the request gate (server.ts).
 *
 * Exempt:
 *   - `/healthz` — liveness probes can't carry a token and the response
 *     is non-sensitive (`{ok: true}`).
 *   - Every non-API path — the SPA shell (`/`), its static assets
 *     (`/assets/<hash>`), and React Router deep links must be reachable
 *     from a fresh browser. Otherwise the user can't load `Login.tsx`
 *     to enter their bearer token (chicken-and-egg, warren-d2a5).
 *
 * Auth-required:
 *   - Every API path other than `/healthz`. `/readyz` stays gated
 *     because its body reveals which checks failed (sensitive in a
 *     misconfigured deploy).
 */
export function isAuthExempt(pathname: string): boolean {
	if (pathname === "/healthz") return true;
	// `/version` is non-sensitive (just the package version string) and
	// the UI fetches it before the user logs in to render in the sidebar
	// header. Keeping it auth-exempt avoids a chicken-and-egg on the
	// login screen.
	if (pathname === "/version") return true;
	// Preview login handshake (R-19 / SPEC §11.L): the browser arrives
	// without an Authorization header and validates the bearer via
	// `?token=<WARREN_API_TOKEN>`. The handler does its own constant-time
	// compare, so the global gate must let the request through.
	if (PREVIEW_LOGIN_PATH_RE.test(pathname)) return true;
	return !isApiPath(pathname);
}

export const API_ROUTE_PATTERNS: readonly { method: Route["method"]; pattern: string }[] =
	ROUTE_TABLE.map((e) => ({ method: e.method, pattern: e.pattern }));

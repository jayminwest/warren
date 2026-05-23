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

import { join } from "node:path";
import type {
	Burrow,
	BurrowKind,
	BurrowState,
	HttpBurrowListFilter,
	MessagePriority,
} from "@os-eco/burrow-cli";
import {
	ATTACHMENT_TYPES,
	type AttachmentType,
	PLOT_STATUSES,
	type PlotStatus,
} from "@os-eco/plot-cli";
import { withTransportMapping } from "../burrow-client/client.ts";
import { fanOutAcrossWorkers } from "../burrow-client/fanout.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import type { AgentRow } from "../db/schema.ts";
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
} from "../diagnostics/checks.ts";
import { VERSION } from "../index.ts";
import {
	PlanHasNoOpenChildrenError,
	ProjectLacksPlotError,
	ProjectLacksSeedsError,
} from "../plan-runs/errors.ts";
import {
	defaultPlanRunPlotAppender,
	emitPlanRunDispatchedToPlot,
} from "../plan-runs/plot-appender.ts";
import { NoDispatchableSeedsError } from "../plot-plan-runs/index.ts";
import {
	createDefaultPlotFormalizer,
	defaultPlotAttacher,
	defaultPlotCreator,
	defaultPlotIntentEditor,
	defaultPlotPrMerger,
	defaultPlotQuestionAnswerer,
	defaultPlotReader,
	defaultPlotRenamer,
	defaultPlotStatusChanger,
	EMPTY_PLOT_SUMMARIES,
	isValidPlotIdFormat,
	type PlotEnvelope,
	PlotIdInvalidError,
	PlotIdNotFoundError,
	type PlotNeedsAttentionSummary,
	type PlotSummary,
	type PlotSummaryArtifact,
	summarizePlot,
} from "../plots/index.ts";
import { createRunPreviewsRepo, DEFAULT_MAX_LIVE } from "../preview/eviction.ts";
import { DEFAULT_PREVIEW_PORT_RANGE, PreviewPortAllocator } from "../preview/port-allocator.ts";
import { teardownPreview } from "../preview/teardown.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../projects/clone.ts";
import { addProject, deleteProject, listProjects, refreshProject } from "../projects/index.ts";
import { type AgentSource, readAgentSource } from "../registry/builtins/index.ts";
import { CanopyClient } from "../registry/canopy.ts";
import {
	type RefreshProjectResult,
	refreshAgentRegistry,
	refreshProjectAgents,
} from "../registry/refresh.ts";
import {
	appendUserMessage,
	buildInteractivePrompt,
	cancelRun,
	defaultPlotContextReader,
	hydrateRunsUsage,
	hydrateRunUsage,
	resolveDispatcherHandle,
	spawnInteractiveTurn,
	spawnRun,
	steerRun,
	tailRunEvents,
} from "../runs/index.ts";
import { showPlan, showSeed } from "../seeds-cli/index.ts";
import { buildTriggerSummaries, parseCron, resolveCronPrompt } from "../triggers/index.ts";
import {
	type CronTrigger,
	DEFAULT_AGENT_PAUSE_TIMEOUT_MS,
	DEFAULT_PREVIEW_MODE,
	type LoadedWarrenConfig,
	loadWarrenConfig,
} from "../warren-config/index.ts";
import { jsonResponse, ndjsonResponse } from "./response.ts";
import type { Route, RouteContext, RouteHandler, ServerDeps } from "./types.ts";

/**
 * Run a command via `Bun.spawn` and return the SpawnResult shape the
 * registry/projects modules expect. Non-zero exit codes are surfaced to
 * the caller; transport-level failures (binary missing, timeout) bubble
 * as the underlying Error so the call-site error mapper can wrap them.
 */
const defaultSpawn: SpawnFn = async (
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

async function readJsonBody(ctx: RouteContext): Promise<Record<string, unknown>> {
	const raw = await ctx.request.text();
	if (raw.length === 0) {
		throw new ValidationError("request body is empty; expected a JSON object");
	}
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

async function readJsonBodyOrEmpty(ctx: RouteContext): Promise<Record<string, unknown> | null> {
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

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`field '${key}' is required and must be a non-empty string`);
	}
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new ValidationError(`field '${key}' must be a string`);
	}
	return value;
}

function requireParam(ctx: RouteContext, key: string): string {
	const value = ctx.params[key];
	if (value === undefined || value.length === 0) {
		throw new ValidationError(`route param '${key}' is missing`);
	}
	return value;
}

function parseBoolean(raw: string | null, label: string): boolean | undefined {
	if (raw === null) return undefined;
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	throw new ValidationError(`${label} must be 'true'/'1' or 'false'/'0'; got '${raw}'`);
}

function parseNonNegativeInt(raw: string | null, label: string): number | undefined {
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
async function assertPlotIdDispatchable(input: {
	readonly plotId: string | undefined;
	readonly plotResolver?: import("../plots/index.ts").PlotResolver;
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
			metadata: { triggerId: trigger.id, cron: trigger.cron, seed: trigger.seed },
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
/* Runs (§8.1)                                                              */
/* ----------------------------------------------------------------------- */

function parseRunsSort(ctx: { url: URL }): { sort: "started" | "cost"; dir: "asc" | "desc" } {
	const rawSort = ctx.url.searchParams.get("sort");
	const rawDir = ctx.url.searchParams.get("dir");
	let sort: "started" | "cost" = "started";
	if (rawSort !== null) {
		if (rawSort !== "started" && rawSort !== "cost") {
			throw new ValidationError("?sort must be 'started' or 'cost'");
		}
		sort = rawSort;
	}
	let dir: "asc" | "desc" = "desc";
	if (rawDir !== null) {
		if (rawDir !== "asc" && rawDir !== "desc") {
			throw new ValidationError("?dir must be 'asc' or 'desc'");
		}
		dir = rawDir;
	}
	return { sort, dir };
}

/**
 * Parse `?limit` / `?offset` for the runs list (warren-ee50 / pl-b0c0
 * step 1). Defaults preserve the historical 100-row window so existing
 * consumers stay byte-compatible; `limit` is clamped to a sane range
 * to keep a paginated UI honest and the server cheap. `offset` is
 * non-negative; the caller is responsible for stitching pages on its
 * end (no opaque cursor — the predicates here are stable + the
 * `runs.id` tiebreaker in `orderByClause` keeps the order total).
 */
function parseRunsPagination(ctx: { url: URL }): { limit: number; offset: number } {
	const rawLimit = ctx.url.searchParams.get("limit");
	const rawOffset = ctx.url.searchParams.get("offset");
	let limit = 100;
	if (rawLimit !== null) {
		const n = Number.parseInt(rawLimit, 10);
		if (!Number.isFinite(n) || n <= 0) {
			throw new ValidationError("?limit must be a positive integer");
		}
		if (n > 500) throw new ValidationError("?limit must be ≤ 500");
		limit = n;
	}
	let offset = 0;
	if (rawOffset !== null) {
		const n = Number.parseInt(rawOffset, 10);
		if (!Number.isFinite(n) || n < 0) {
			throw new ValidationError("?offset must be a non-negative integer");
		}
		offset = n;
	}
	return { limit, offset };
}

function listRunsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const project = ctx.url.searchParams.get("project");
		const agent = ctx.url.searchParams.get("agent");
		if (project !== null && agent !== null) {
			throw new ValidationError("filter by either ?project=... or ?agent=..., not both");
		}
		const order = parseRunsSort(ctx);
		const page = parseRunsPagination(ctx);
		const listOpts = { ...order, ...page };
		const rows =
			project !== null
				? await deps.repos.runs.listByProject(project, listOpts)
				: agent !== null
					? await deps.repos.runs.listByAgent(agent, listOpts)
					: await deps.repos.runs.listAll(listOpts);
		// warren-ab18: surface in-events cost for terminal runs whose
		// bridge died before the final checkpoint landed.
		const runs = await hydrateRunsUsage(rows, deps.repos.events);
		// warren-ee50 / pl-b0c0 step 1: aggregate the full filtered set so
		// the Runs page can show all-time totals next to a paginated table.
		const aggFilter = {
			...(project !== null ? { projectId: project } : {}),
			...(agent !== null ? { agentName: agent } : {}),
		};
		const agg = await deps.repos.runs.aggregate(aggFilter);
		return jsonResponse(200, {
			runs,
			total: agg.total,
			costTotalUsd: agg.costTotalUsd,
			costPricedCount: agg.costPricedCount,
			limit: page.limit,
			offset: page.offset,
		});
	};
}

function getRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const row = await deps.repos.runs.require(id);
		// warren-ab18: same compute-on-read fallback as the list handler
		// so the RunDetail page shows cost for ghost / reboot-orphaned runs.
		const run = await hydrateRunUsage(row, deps.repos.events);
		return jsonResponse(200, run);
	};
}

/**
 * Parse the optional `mode` body field on `POST /runs` (pl-0344 step 4 /
 * warren-b3b9). Defaults to `'batch'` so existing single-shot dispatch
 * callers are byte-identical. `'interactive'` opts in to the
 * respawn-per-turn primitive (`src/runs/interactive.ts`); when set,
 * `plotId` is required and `interactiveAgent` may override `agent`.
 */
function parseRunMode(body: Record<string, unknown>): "batch" | "interactive" {
	const raw = body.mode;
	if (raw === undefined || raw === null) return "batch";
	if (raw !== "batch" && raw !== "interactive") {
		throw new ValidationError(
			`field 'mode' must be 'batch' or 'interactive'; got ${JSON.stringify(raw)}`,
		);
	}
	return raw;
}

function createRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const mode = parseRunMode(body);
		const ref = optionalString(body, "ref");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const seedId = optionalString(body, "seedId");
		const plotId = optionalString(body, "plotId");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		// `interactiveAgent` overrides `agent` when mode='interactive' (pl-0344
		// step 4 / warren-b3b9). The field is dedicated so a UI surface that
		// always sends both `agent` (batch default) and `interactiveAgent`
		// (brainstorm/planner preset) can flip mode without re-keying.
		const interactiveAgent = optionalString(body, "interactiveAgent");
		const agentName =
			mode === "interactive" && interactiveAgent !== undefined
				? interactiveAgent
				: requireString(body, "agent");
		const projectId = requireString(body, "project");
		const prompt = requireString(body, "prompt");

		// warren-bae5 / pl-5310 step 2: validate plot_id BEFORE handing off
		// to spawnRun so a malformed or non-existent plot_id fails at the
		// operator-facing edge instead of silently no-opping at the
		// host-side defaultPlotAppender. Empty string is normalized to "no
		// plot bound" (matches spawnRun's posture and the createPlanRun gate).
		await assertPlotIdDispatchable({ plotId, plotResolver: deps.plotResolver });

		// Interactive runs REQUIRE a plot_id — the primitive is meaningless
		// without a Plot to bind the conversation to. Validated AFTER format
		// + existence so the more-specific format error still wins when both
		// apply.
		if (mode === "interactive" && (plotId === undefined || plotId === "")) {
			throw new ValidationError(
				"plotId is required when mode='interactive'; interactive runs bind to a Plot",
				{
					recoveryHint: "either pass plotId on POST /runs, or omit `mode` to dispatch a batch run",
				},
			);
		}

		// Compose the dispatch prompt. Batch runs ship the operator-supplied
		// prompt verbatim. Interactive first-turn dispatches wrap it in the
		// same <plot_context> + <user_message> envelope the follow-up turn
		// builder (`spawnInteractiveTurn`) emits, so the agent sees a uniform
		// prompt shape across turn 1 and turn N. Context load is best-effort
		// — a torn `.plot/.index.db` or vanished events file falls back to
		// the user message alone.
		let dispatchedPrompt = prompt;
		if (mode === "interactive" && plotId !== undefined && plotId !== "") {
			const project = await deps.repos.projects.require(projectId);
			const handle = resolveDispatcherHandle(dispatcherHandle);
			let context = null;
			try {
				context = await defaultPlotContextReader.read({
					plotDir: join(project.localPath, ".plot"),
					plotId,
					historyTail: 0,
					handle,
				});
			} catch {
				// Best-effort — first-turn dispatches still proceed without
				// the envelope. spawnInteractiveTurn captures the same
				// degradation as a system event; on first turn we don't yet
				// have a run row to attach the warning to.
			}
			dispatchedPrompt = buildInteractivePrompt(context, prompt);
		}

		const result = await spawnRun({
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			agentName,
			projectId,
			prompt: dispatchedPrompt,
			mode,
			...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(seedId !== undefined ? { seedId } : {}),
			...(plotId !== undefined ? { plotId } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			...(deps.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
				: {}),
			...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
		});

		// First-turn interactive dispatch: append the raw user_message event
		// onto the new run so the events stream reflects the conversation
		// from turn 0. `spawnInteractiveTurn` (follow-up turns) does the same.
		if (mode === "interactive") {
			await appendUserMessage({
				repos: deps.repos,
				runId: result.run.id,
				message: prompt,
				handle: resolveDispatcherHandle(dispatcherHandle),
				...(deps.now !== undefined ? { now: deps.now() } : {}),
			});
		}

		// Hand off to the bridge so events start flowing into warren.events
		// — without this the dispatched run would emit events into burrow
		// but the warren wire would never see them.
		deps.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
		return jsonResponse(201, {
			run: result.run,
			burrow: { id: result.burrow.id, workspacePath: result.burrow.workspacePath },
		});
	};
}

/**
 * `POST /runs/:id/messages` — send a follow-up user turn on an
 * interactive conversation (pl-0344 step 4 / warren-b3b9).
 *
 * `:id` is the conversation handle — any prior interactive run row that
 * shares the same plotId works (the handler resolves the plot context
 * from disk, not from this row). Returns **202 Accepted** with the
 * freshly-spawned turn row + burrow descriptor + user_message event:
 * the dispatch is async (the agent reply lands later as an
 * `agent_message` event captured at reap), and 202 is the canonical
 * "queued for processing, see events stream for completion" shape.
 *
 * Body: `{message: string, dispatcherHandle?: string, providerOverride?,
 * modelOverride?, ref?}`. Field shape mirrors `POST /runs` so a UI
 * surface can reuse its dispatch plumbing.
 *
 * Errors:
 *   - 400 `validation_error` — missing/empty message, prior run is not
 *     mode='interactive', prior run has no plot_id, message is empty.
 *   - 404 `not_found` — prior run id doesn't exist.
 *
 * The follow-up turn is registered with the bridge the same way `POST
 * /runs` does, so its events flow onto warren's stream immediately.
 */
function postRunMessageHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const message = requireString(body, "message");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const ref = optionalString(body, "ref");

		const result = await spawnInteractiveTurn({
			runId: id,
			message,
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			trigger: "interactive",
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			...(deps.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
				: {}),
			...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
		});

		deps.bridges.start(result.turn.run.id, result.turn.burrowRun.id, result.turn.burrow.id);

		return jsonResponse(202, {
			run: result.turn.run,
			burrow: {
				id: result.turn.burrow.id,
				workspacePath: result.turn.burrow.workspacePath,
			},
			userMessageEvent: {
				id: result.userMessageEvent.id,
				runId: result.userMessageEvent.runId,
				seq: result.userMessageEvent.burrowEventSeq,
				ts: result.userMessageEvent.ts,
				kind: result.userMessageEvent.kind,
			},
			priorRunId: result.priorRun.id,
			plotContextDegraded: result.plotContextDegraded,
		});
	};
}

function steerRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const result = await steerRun({
			runId: id,
			body: requireString(body, "body"),
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(optionalString(body, "priority") !== undefined
				? { priority: optionalString(body, "priority") as MessagePriority }
				: {}),
			...(optionalString(body, "fromActor") !== undefined
				? { fromActor: optionalString(body, "fromActor") as string }
				: {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, { message: result.message });
	};
}

function cancelRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const reason = body !== null ? optionalString(body, "reason") : undefined;
		const result = await cancelRun({
			runId: id,
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(reason !== undefined ? { reason } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
		});
		return jsonResponse(200, {
			state: result.state,
			alreadyTerminal: result.alreadyTerminal,
			burrowRun: result.burrowRun,
		});
	};
}

/**
 * `GET /runs/:id/preview/login?token=<bearer>&redirect=<absolute-url>`
 * (R-19 / SPEC §11.L, warren-8a10; path-mode redirect warren-edff;
 * per-run cookie name warren-63e1).
 *
 * The signed-cookie handshake the preview proxy depends on. A browser
 * hitting a preview origin directly can't carry an Authorization header,
 * so the operator opens this URL on the warren host, the handler
 * validates the bearer in the query, sets a scoped `warren_preview*`
 * cookie, and 302s to the preview.
 *
 *   - **Subdomain mode** (`deps.previewMode === "subdomain"`): cookie name
 *     `warren_preview`, `Domain=.<host>; Path=/`; redirect must be
 *     `https://run-<id>.<previewHost>/...`.
 *   - **Path mode** (default; `deps.previewMode === "path"`): cookie name
 *     `warren_preview_<runId>` (per-run literal suffix, warren-63e1),
 *     `Path=/` with no `Domain`; redirect must be same-origin as the
 *     inbound request and live under `/p/<id>/`. The cookie ships on
 *     every same-origin request so referer-based asset routing in the
 *     proxy preamble can authenticate sub-resource loads.
 *
 * This route is auth-exempt (`isAuthExempt` whitelists `/preview/login`)
 * because the standard bearer gate would 401 the browser before the
 * handler ever ran. The handler does its own bearer check via
 * `previewAuth.verifyLoginToken` (constant-time compare against the
 * configured `WARREN_API_TOKEN`).
 *
 * `redirect` is constrained to the run's own preview surface — anything
 * else is rejected so a stolen login link can't become an open redirect.
 *
 * 400 when `previewAuth` is null (subdomain mode with no host, or
 * warren booted with `--no-auth`); the proxy is also disabled in those
 * configurations so the handshake has nothing to issue against.
 */
function previewLoginHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const runId = requireParam(ctx, "id");
		const mode: "subdomain" | "path" = deps.previewMode ?? "subdomain";
		if (deps.previewAuth === undefined) {
			throw new ValidationError("preview surface is not configured on this warren", {
				recoveryHint:
					"ensure WARREN_API_TOKEN is set (and WARREN_PREVIEW_HOST when WARREN_PREVIEW_MODE=subdomain) to enable per-run previews",
			});
		}
		if (mode === "subdomain" && deps.previewHost === undefined) {
			throw new ValidationError("preview surface is not configured on this warren", {
				recoveryHint:
					"set WARREN_PREVIEW_HOST to enable subdomain-mode previews, or switch to WARREN_PREVIEW_MODE=path",
			});
		}
		const token = ctx.url.searchParams.get("token");
		if (!deps.previewAuth.verifyLoginToken(token)) {
			return jsonResponse(401, {
				error: {
					code: "unauthorized",
					message: "preview login requires a valid ?token=<WARREN_API_TOKEN>",
				},
			});
		}
		// 404 fast if the run isn't known — issuing a cookie for a nonexistent
		// run would let an attacker pre-seed a session keyed off a future id.
		await deps.repos.runs.require(runId);

		const redirect = ctx.url.searchParams.get("redirect");
		const redirectTarget =
			mode === "path"
				? resolvePathPreviewRedirect(redirect, runId, ctx.url.origin)
				: resolveSubdomainPreviewRedirect(redirect, runId, deps.previewHost as string);
		if (redirectTarget === null) {
			const hint =
				mode === "path"
					? `redirect must be a same-origin URL under ${ctx.url.origin}/p/${runId}/`
					: `redirect must be an absolute URL under https://run-${runId}.${deps.previewHost}/`;
			return jsonResponse(400, {
				error: {
					code: "preview_redirect_invalid",
					message: hint,
				},
			});
		}

		const now = deps.now?.() ?? new Date();
		const cookie = deps.previewAuth.signCookie(runId, now);
		return new Response(null, {
			status: 302,
			headers: {
				location: redirectTarget,
				"set-cookie": cookie.setCookieHeader,
			},
		});
	};
}

function resolveSubdomainPreviewRedirect(
	raw: string | null,
	runId: string,
	host: string,
): string | null {
	const fallback = `https://run-${runId}.${host}/`;
	if (raw === null || raw.length === 0) return fallback;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	if (parsed.hostname !== `run-${runId}.${host}`) return null;
	return parsed.toString();
}

function resolvePathPreviewRedirect(
	raw: string | null,
	runId: string,
	inboundOrigin: string,
): string | null {
	const fallback = `${inboundOrigin}/p/${runId}/`;
	if (raw === null || raw.length === 0) return fallback;
	let parsed: URL;
	try {
		// Relative URLs (`/p/<id>/foo`) resolve against the inbound origin so
		// callers don't have to know the scheme/host upfront. Absolute URLs are
		// then origin-checked below.
		parsed = new URL(raw, inboundOrigin);
	} catch {
		return null;
	}
	if (parsed.origin !== inboundOrigin) return null;
	if (!parsed.pathname.startsWith(`/p/${runId}/`)) return null;
	return parsed.toString();
}

/**
 * `POST /runs/:id/preview/teardown` (R-19 / SPEC §11.L acceptance #8,
 * warren-d725).
 *
 * Idempotent operator-driven teardown of the per-run preview. Bearer-
 * required (the global auth gate covers `/runs/*`; this route is not
 * in `isAuthExempt`). The body is optional — `{actor}` is forwarded
 * onto the audit event for attribution, defaulting to `"manual"`.
 *
 * Responds 200 on every CAS outcome (`torn-down`, `already-torn-down`,
 * `already-failed`, `never-launched`); 404 on unknown runId; 503 when
 * `deps.db` is undefined (no repo layer wired). Works on both sqlite
 * and postgres dialects — `createRunPreviewsRepo` is dialect-
 * polymorphic (warren-adfb), so the eviction-worker CAS path that
 * teardown rides on is already exercised on pg in production. The
 * route is `tornDown: true` only when the call actually flipped a
 * `starting`/`live` row.
 */
function previewTeardownHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const runId = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const actor = body !== null ? optionalString(body, "actor") : undefined;

		if (deps.db === undefined) {
			return jsonResponse(503, {
				error: {
					code: "preview_teardown_unavailable",
					message: "preview teardown requires the repo layer; this warren has no db handle wired",
				},
			});
		}

		const previews = createRunPreviewsRepo(deps.db);
		const result = await teardownPreview({
			runId,
			repos: deps.repos,
			previews,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(actor !== undefined ? { actor } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			logger: teardownLoggerFor(deps),
		});

		return jsonResponse(200, {
			status: result.status,
			tornDown: result.tornDown,
			previousState: result.previousState,
			port: result.port,
		});
	};
}

/**
 * Narrow `ServerDeps.logger` (the pino-shaped surface) onto the
 * `Record<string, unknown>` signature the preview teardown / eviction
 * code expects. Same shape the boot path already builds for the
 * eviction worker — kept inline here to avoid threading another
 * `*LoggerFromPino` adapter down through `ServerDeps`.
 */
function teardownLoggerFor(deps: ServerDeps): {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
} {
	return {
		info: (obj, msg) => deps.logger.info(obj, msg),
		warn: (obj, msg) => deps.logger.warn(obj, msg),
		error: (obj, msg) => deps.logger.error(obj, msg),
	};
}

function streamRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast if the run isn't known — without this we'd happily
		// stream an empty NDJSON forever for a typo'd id.
		const run = await deps.repos.runs.require(id);

		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const sinceSeq = parseNonNegativeInt(ctx.url.searchParams.get("since"), "since");

		const ctrl = bridgeAbort(ctx.request.signal);
		const source = tailRunEvents({
			runId: id,
			repos: { events: deps.repos.events },
			broker: deps.broker,
			follow,
			...(sinceSeq !== undefined ? { sinceSeq } : {}),
			signal: ctrl.signal,
		});
		// warren-a8c3: tag every NDJSON envelope with the run's plot_id so
		// Plot-aware consumers can route mirrored events (warren-7e0f) without
		// a second GET /runs/:id call. Snapshot at stream-open time — plot_id
		// is set at spawn and never mutates, so the closure-captured value is
		// authoritative for the life of the stream.
		const plotId = run.plotId;
		return ndjsonResponse(asNdjsonStream(source, (row) => eventToNdjson(row, plotId), ctrl));
	};
}

/* ----------------------------------------------------------------------- */
/* Streaming plumbing                                                       */
/* ----------------------------------------------------------------------- */

function bridgeAbort(reqSignal: AbortSignal): AbortController {
	const ctrl = new AbortController();
	if (reqSignal.aborted) {
		ctrl.abort();
		return ctrl;
	}
	reqSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
	return ctrl;
}

function asNdjsonStream<T>(
	source: AsyncIterable<T>,
	encode: (value: T) => string,
	ctrl: AbortController,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(encode(value)));
			} catch (err) {
				if (ctrl.signal.aborted) {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		async cancel() {
			ctrl.abort();
			try {
				await iterator.return?.(undefined);
			} catch {
				// ignore — generator's finally is the source of truth
			}
		},
	});
}

function eventToNdjson(
	row: {
		id: number;
		runId: string;
		burrowEventSeq: number;
		ts: string;
		kind: string;
		stream: string | null;
		payloadJson: unknown;
	},
	plotId: string | null = null,
): string {
	return `${JSON.stringify({
		id: row.id,
		runId: row.runId,
		seq: row.burrowEventSeq,
		ts: row.ts,
		kind: row.kind,
		stream: row.stream,
		payload: row.payloadJson,
		plotId,
	})}\n`;
}

/* ----------------------------------------------------------------------- */
/* Plan runs (warren-f923 / pl-a258 step 6)                                 */
/* ----------------------------------------------------------------------- */

const PLAN_RUN_ACCEPTED_PLAN_STATUSES = ["approved", "active", "done"] as const;
const PLAN_RUN_STATE_FILTER_VALUES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;
type PlanRunStateFilter = (typeof PLAN_RUN_STATE_FILTER_VALUES)[number];

function parsePlanRunStateFilter(raw: string | null): PlanRunStateFilter | undefined {
	if (raw === null) return undefined;
	if (!(PLAN_RUN_STATE_FILTER_VALUES as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`?state must be one of ${PLAN_RUN_STATE_FILTER_VALUES.join(", ")}; got '${raw}'`,
		);
	}
	return raw as PlanRunStateFilter;
}

/**
 * `POST /plan-runs` — kick off a serial plan execution against a seeds plan.
 *
 * Handler order (warren-f923):
 *   (1) load project; 404 if missing.
 *   (2) reject when project.hasSeeds is false (ProjectLacksSeedsError mirrors
 *       the plot reject shape at warren-a8c3 — same ValidationError → 400
 *       envelope, stable code so HTTP consumers can branch on it).
 *   (2b) reject when plot_id is set but project.hasPlot is false
 *       (ProjectLacksPlotError, warren-c900 / pl-7937 Phase 2). Same 400
 *       envelope; raised before the seeds-CLI fan-out so a non-Plot project
 *       never grows a half-validated plan-run.
 *
 *   Gates (2) and (2b) are **stacked, not independent** (warren-909c /
 *   pl-7937 step 6): seeds is the base, plot is the optional layer on top.
 *   A project missing .seeds/ is rejected as `project_lacks_seeds` even
 *   when plot_id is supplied — plot_id never short-circuits the .seeds/
 *   requirement, and PlanRun-with-plot only lights up when BOTH .seeds/
 *   AND .plot/ are present.
 *   (3) call showPlan; assert plan.status is in (approved, active, done) and
 *       at least one open child exists (PlanHasNoOpenChildrenError).
 *   (4) resolve agent via repos.agents.resolve with the project-tier fallback
 *       (mx-644fb5 — same posture as spawnRun).
 *   (5/6) build + persist plan_runs + plan_run_children rows in a single
 *       repo.create call (the repo runs them in a transaction so a half-
 *       inserted PlanRun never appears to listActive). plot_id rides through
 *       the same call (default null when omitted).
 *   (7) return 201 with {planRun, children}.
 */
function createPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const projectId = requireString(body, "project");
		const planId = requireString(body, "planId");
		const agentName = requireString(body, "agent");
		const promptTemplate = optionalString(body, "promptTemplate");
		const ref = optionalString(body, "ref");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		const plotId = optionalString(body, "plotId");

		// (1) project lookup — NotFoundError → 404.
		const project = await deps.repos.projects.require(projectId);

		// (2) hasSeeds gate.
		if (!project.hasSeeds) {
			throw new ProjectLacksSeedsError(
				`project ${project.id} has no .seeds/ directory; plan-runs are not accepted`,
				{
					recoveryHint: "add a .seeds/ directory to the project clone and refresh",
				},
			);
		}

		// (2b) hasPlot gate — symmetric to single-run's spawn-time check
		// (src/runs/spawn.ts, warren-a8c3). Empty-string plot_id is treated
		// as "not provided" to match the single-run handler's posture.
		if (plotId !== undefined && plotId !== "" && !project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} has no .plot/ directory; plot_id is not accepted`,
				{
					recoveryHint:
						"either omit plot_id on POST /plan-runs, or run `plot init` in the project clone and refresh the project so warren picks up the .plot/ directory",
				},
			);
		}

		// (2c) warren-bae5 / pl-5310 step 2: plot_id format + existence
		// validation, mirroring createRunHandler's check. Layered AFTER
		// ProjectLacksPlotError so the more-specific project-shape error
		// still wins when both apply.
		await assertPlotIdDispatchable({ plotId, plotResolver: deps.plotResolver });

		// (3) read the plan via seeds-cli.
		if (deps.seedsCli === undefined) {
			throw new ValidationError(
				"seeds CLI is not configured on this warren; plan-runs require sd",
				{ recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart" },
			);
		}
		const plan = await showPlan(deps.seedsCli, project.localPath, planId);
		if (!(PLAN_RUN_ACCEPTED_PLAN_STATUSES as readonly string[]).includes(plan.status)) {
			throw new ValidationError(
				`plan ${planId} is in status '${plan.status}'; plan-runs require one of ${PLAN_RUN_ACCEPTED_PLAN_STATUSES.join(", ")}`,
				{
					recoveryHint: "approve or activate the plan in seeds, then retry POST /plan-runs",
				},
			);
		}
		if (plan.children.length === 0) {
			throw new PlanHasNoOpenChildrenError(`plan ${planId} has no children; nothing to dispatch`, {
				recoveryHint: "run `sd plan submit <seed-id>` to populate the plan's children",
			});
		}
		// Probe every child seed's status — if all are already closed there is
		// nothing to dispatch. Each child is read in parallel since the seeds
		// CLI is shell-out + filesystem read, not network.
		const seedsCli = deps.seedsCli;
		const childStatuses = await Promise.all(
			plan.children.map((seedId) =>
				showSeed(seedsCli, project.localPath, seedId).then((s) => ({
					seedId,
					status: s.status,
				})),
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

		// (4) agent resolve with project-tier fallback (mx-644fb5).
		const agent = await deps.repos.agents.resolve(agentName, { projectId: project.id });
		if (agent === null) {
			throw new NotFoundError(`agent not found: ${agentName}`, {
				recoveryHint: "POST /agents/refresh to re-discover from canopy",
			});
		}

		// (5/6) persist.
		const result = await deps.repos.planRuns.create({
			planId,
			projectId: project.id,
			agentName: agent.name,
			children: plan.children.map((seedId, index) => ({ seq: index + 1, seedId })),
			...(promptTemplate !== undefined ? { promptTemplate } : {}),
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			...(plotId !== undefined && plotId !== "" ? { plotId } : {}),
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});

		// (6b) warren-b89f / pl-7937 step 4: emit one `plan_run_dispatched`
		// event onto the bound Plot — fire-and-log, mirrors the single-run
		// `defaultPlotAppender` posture in src/runs/spawn.ts:407–425. The
		// PlanRun row is durably persisted by this point, so a Plot-write
		// failure logs `plan_run.plot_append_failed` and the POST still
		// returns 201.
		if (result.planRun.plotId !== null) {
			await emitPlanRunDispatchedToPlot({
				appender: deps.planRunPlotAppender ?? defaultPlanRunPlotAppender,
				logger: deps.logger,
				plotDir: join(project.localPath, ".plot"),
				plotId: result.planRun.plotId,
				handle: resolveDispatcherHandle(result.planRun.dispatcherHandle),
				planRunId: result.planRun.id,
				planId: result.planRun.planId,
				childrenCount: result.children.length,
			});
		}

		// (7) wire response — coordinator picks the row up on its next tick.
		return jsonResponse(201, {
			planRun: result.planRun,
			children: result.children,
		});
	};
}

/* ----------------------------------------------------------------------- */
/* POST /plot-plan-runs (warren-99b2 / pl-f404 step 3 / SPEC §11.Q)        */
/* ----------------------------------------------------------------------- */

/**
 * `seeds_issue` attachments whose `ref` shape looks like a seeds plan
 * id (`pl-*`) are excluded from synthesis. They already have a per-row
 * "Run plan" dispatch path on PlotDetail (warren-5d94) and should be
 * dispatched as plans, not adopted as plan-run children. Mirrors the
 * UI-side `isSdPlanAttachment` predicate (src/ui/src/pages/PlotDetail.tsx).
 */
function isSdPlanAttachmentRef(ref: string): boolean {
	return /^pl-/i.test(ref);
}

/**
 * `POST /plot-plan-runs` — synthesize a seeds plan from a Plot's open
 * `seeds_issue` attachments, then dispatch it through the same machinery
 * as `POST /plan-runs`. See SPEC §11.Q for the full design.
 *
 * Handler order:
 *   (1) validate plot_id format (`PlotIdInvalidError`, warren-bae5).
 *   (2) load project by `project_id` from the body (NotFoundError → 404).
 *   (3) `project.hasPlot` gate (`ProjectLacksPlotError`, mirrors POST
 *       /plan-runs at mx-afe7e0).
 *   (4) `project.hasSeeds` gate (`ProjectLacksSeedsError`, mirrors POST
 *       /plan-runs). Order matches §11.P's gate-stack convention —
 *       seeds-first means plot_id never short-circuits the .seeds/
 *       requirement (warren-909c / pl-7937 step 6); the symmetric
 *       reasoning applies here even though the surface mandates plot_id.
 *   (5) verify the plot exists in this project's `.plot/` index via
 *       `plotResolver` (`PlotIdNotFoundError`, warren-bae5).
 *   (6) read the Plot envelope, filter `attachments` to open
 *       `seeds_issue` refs that are NOT `pl-*` shaped (the latter would
 *       dispatch via the per-plan button, not synthesis). The seed-
 *       status check shells out per-candidate via `showSeed` — same
 *       pattern as POST /plan-runs.
 *   (7) if zero candidates remain → `NoDispatchableSeedsError` (400).
 *   (8) synthesize: mint a fresh throwaway parent seed, submit a plan
 *       whose `steps[]` adopt the candidates via `existing_seed`
 *       (seeds-cli 0.4.7, warren-d519).
 *   (9) showPlan on the freshly synthesized plan — same shape POST
 *       /plan-runs reads — and run agent resolve + create + Plot
 *       append exactly like POST /plan-runs does (no shortcut path,
 *       so every §11.P / §11.P.Plot wiring lights up unmodified).
 *   (10) return 201 with `{planRun, children, synthesizedPlanId,
 *        parentSeedId}` — same `{planRun, children}` shape POST
 *        /plan-runs returns, plus two synthesis-specific fields so
 *        the UI can navigate to `/plan-runs/:id` AND surface the
 *        synthesized plan id for debugging.
 */
function createPlotPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const plotId = requireString(body, "plot_id");
		const projectId = requireString(body, "project_id");
		const agentName = requireString(body, "agent_name");
		const promptTemplate = optionalString(body, "prompt_template");
		const ref = optionalString(body, "ref");
		const providerOverride = optionalString(body, "provider_override");
		const modelOverride = optionalString(body, "model_override");
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (1) plot_id format validation (warren-bae5 / pl-5310 step 2). Done
		// up-front so a malformed id never reaches the project lookup.
		if (!isValidPlotIdFormat(plotId)) {
			throw new PlotIdInvalidError(
				`plot_id ${JSON.stringify(plotId)} is not a valid Plot ID (expected shape: plot-<lower-alphanum>+)`,
				{
					recoveryHint:
						"Plot IDs look like `plot-3e72876d`. Visit /plots to copy the canonical id of an existing Plot.",
				},
			);
		}

		// (2) project lookup.
		const project = await deps.repos.projects.require(projectId);

		// (3) hasPlot gate — same shape as POST /plots and POST /plan-runs.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} has no .plot/ directory; cannot synthesize a plan-run from a Plot`,
				{
					recoveryHint:
						"run `plot init` in the project clone and refresh the project so warren picks up the .plot/ directory",
				},
			);
		}

		// (4) hasSeeds gate — synthesis writes via `sd plan submit` so a
		// project without .seeds/ has nowhere to land the plan.
		if (!project.hasSeeds) {
			throw new ProjectLacksSeedsError(
				`project ${project.id} has no .seeds/ directory; cannot synthesize a plan-run`,
				{
					recoveryHint: "add a .seeds/ directory to the project clone and refresh",
				},
			);
		}

		// (5) plot_id existence — resolver returns the owning project, or
		// null when no `hasPlot=true` project's index contains the id.
		// `null` and "owns a different project" both surface as
		// `PlotIdNotFoundError` so the caller's body is consistent.
		if (deps.plotResolver !== undefined) {
			const owning = await deps.plotResolver.resolve(plotId);
			if (owning === null || owning.id !== project.id) {
				throw new PlotIdNotFoundError(
					`plot_id ${plotId} does not match any Plot in project ${project.id}`,
					{
						recoveryHint: "verify the Plot exists at /plots and is owned by the named project",
					},
				);
			}
		}

		// (6) read the Plot envelope and filter to dispatchable candidates.
		const reader = deps.plotReader ?? defaultPlotReader;
		const envelope = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
		});
		const seedsCandidates = envelope.attachments.filter(
			(a) => a.type === "seeds_issue" && !isSdPlanAttachmentRef(a.ref),
		);

		// Seeds CLI is required from here on (status probe + synthesis +
		// post-synthesis showPlan all shell out). Reject early with the
		// same shape POST /plan-runs uses.
		if (deps.seedsCli === undefined) {
			throw new ValidationError(
				"seeds CLI is not configured on this warren; plot-plan-runs require sd",
				{ recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart" },
			);
		}
		const seedsCli = deps.seedsCli;

		// Closed seeds are dropped at the handler edge (plan-creation should
		// be intentional, not a silent skip). Status probe is parallel —
		// each call is shell + filesystem read.
		const statuses = await Promise.all(
			seedsCandidates.map((a) =>
				showSeed(seedsCli, project.localPath, a.ref).then((s) => ({
					ref: a.ref,
					status: s.status,
				})),
			),
		);
		const dispatchableRefs = statuses.filter((s) => s.status !== "closed").map((s) => s.ref);

		// (7) zero dispatchable → typed 400.
		if (dispatchableRefs.length === 0) {
			throw new NoDispatchableSeedsError(
				`Plot ${plotId} has no dispatchable seeds_issue attachments (all are closed, sd_plan-shaped, or missing)`,
				{
					recoveryHint:
						"attach open seeds_issue items to this Plot first, or close and re-create the Plot if all attached seeds are already merged",
				},
			);
		}

		// (8) synthesize. The synthesizer mints a parent seed + plan via
		// two `sd` shell-outs; failures bubble as SdPlanSynthesisError
		// (500-mapped) so a downstream consumer can distinguish synthesis
		// failure from the typed handler-edge rejects.
		if (deps.planSynthesizer === undefined) {
			throw new ValidationError("plot-plan-run synthesis is not configured on this warren", {
				recoveryHint: "ensure seeds CLI is configured and bootServer wires planSynthesizer",
			});
		}
		const synthesized = await deps.planSynthesizer.synthesize({
			projectPath: project.localPath,
			plotId,
			candidateSeedIds: dispatchableRefs,
		});

		// (9) re-read the synthesized plan via the same showPlan path
		// POST /plan-runs uses, then walk children to confirm at least
		// one is open. (This double-read is paid against the just-
		// committed plan, so it always succeeds in practice; keeping the
		// reuse of POST /plan-runs's contract is worth the extra read.)
		const plan = await showPlan(seedsCli, project.localPath, synthesized.planId);
		if (plan.children.length === 0) {
			throw new PlanHasNoOpenChildrenError(
				`synthesized plan ${synthesized.planId} has no children; nothing to dispatch`,
				{
					recoveryHint:
						"this is an internal warren state — re-attach open seeds_issue items to the Plot and retry POST /plot-plan-runs",
				},
			);
		}

		// Resolve agent with project-tier fallback (mirrors POST /plan-runs).
		const agent = await deps.repos.agents.resolve(agentName, { projectId: project.id });
		if (agent === null) {
			throw new NotFoundError(`agent not found: ${agentName}`, {
				recoveryHint: "POST /agents/refresh to re-discover from canopy",
			});
		}

		// Persist plan_run + plan_run_children + plotId.
		const result = await deps.repos.planRuns.create({
			planId: synthesized.planId,
			projectId: project.id,
			agentName: agent.name,
			children: plan.children.map((seedId, index) => ({ seq: index + 1, seedId })),
			...(promptTemplate !== undefined ? { promptTemplate } : {}),
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			plotId,
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});

		// Plot append (mirrors POST /plan-runs at mx-92e6b3 — fire-and-log
		// per defaultPlotAppender; a Plot-write failure logs and the 201
		// still ships).
		await emitPlanRunDispatchedToPlot({
			appender: deps.planRunPlotAppender ?? defaultPlanRunPlotAppender,
			logger: deps.logger,
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle: resolveDispatcherHandle(result.planRun.dispatcherHandle),
			planRunId: result.planRun.id,
			planId: result.planRun.planId,
			childrenCount: result.children.length,
		});

		// (10) response — POST /plan-runs's `{planRun, children}` shape,
		// plus synthesis-specific fields so the UI can render both the
		// PlanRun navigation target AND the synthesized plan id.
		return jsonResponse(201, {
			planRun: result.planRun,
			children: result.children,
			synthesizedPlanId: synthesized.planId,
			parentSeedId: synthesized.parentSeedId,
		});
	};
}

/**
 * `GET /plan-runs?project=&state=` — list plan-runs, optionally filtered.
 * Options-bag shape mirrors `listRunsHandler` (mx-f1a881) so a UI rendering
 * either endpoint can share its query plumbing.
 */
function listPlanRunsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const projectId = ctx.url.searchParams.get("project");
		const state = parsePlanRunStateFilter(ctx.url.searchParams.get("state"));
		if (projectId !== null) {
			const rows = await deps.repos.planRuns.listByProjectAndState(
				projectId,
				state !== undefined ? state : undefined,
			);
			return jsonResponse(200, { planRuns: rows });
		}
		// No project filter — return active PlanRuns when no state requested,
		// or the operator's chosen state across every project.
		if (state !== undefined) {
			// listByProjectAndState requires a project; for a state-only view
			// we walk projects sequentially. Volume is tiny relative to runs
			// (one plan-run per dispatched plan, not per child).
			const projects = await deps.repos.projects.listAll();
			const all = (
				await Promise.all(
					projects.map((p) => deps.repos.planRuns.listByProjectAndState(p.id, state)),
				)
			).flat();
			return jsonResponse(200, { planRuns: all });
		}
		return jsonResponse(200, { planRuns: await deps.repos.planRuns.listActive() });
	};
}

/**
 * `GET /plan-runs/:id` — full detail page payload: row + children + the
 * fanned-out `runs[]` from runs.listByIds(child.runId for each non-null)
 * so the UI's detail page renders in one round-trip.
 */
function getPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		const children = await deps.repos.planRuns.listChildren(id);
		const runIds = children.map((c) => c.runId).filter((v): v is string => v !== null);
		const runs = await deps.repos.runs.listByIds(runIds);
		return jsonResponse(200, { planRun, children, runs });
	};
}

/**
 * `POST /plan-runs/:id/cancel` — flip the plan-run to `cancelled` and, if
 * a child run is in-flight (dispatched / running / pr_open), forward a
 * cancel to that child via the existing `cancelRun` seam.
 *
 * Idempotent against an already-terminal plan-run: returns the current row
 * without firing a second cancel.
 */
function cancelPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		if (
			planRun.state === "cancelled" ||
			planRun.state === "succeeded" ||
			planRun.state === "failed"
		) {
			return jsonResponse(200, {
				planRun,
				cancelledChild: null,
				alreadyTerminal: true,
			});
		}

		const children = await deps.repos.planRuns.listChildren(id);
		const inFlight = children.find(
			(c) => c.state === "dispatched" || c.state === "running" || c.state === "pr_open",
		);

		const endedAt = (deps.now?.() ?? new Date()).toISOString();
		const cancelled = await deps.repos.planRuns.transitionTo(planRun.id, "cancelled", {
			endedAt,
		});

		let cancelledChild: { childSeq: number; runId: string } | null = null;
		if (inFlight !== undefined && inFlight.runId !== null) {
			try {
				await cancelRun({
					runId: inFlight.runId,
					repos: deps.repos,
					burrowClientPool: deps.burrowClientPool,
					broker: deps.broker,
					reason: `plan_run_cancelled:${planRun.id}`,
					...(deps.now !== undefined ? { now: deps.now } : {}),
					...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
				});
				cancelledChild = { childSeq: inFlight.seq, runId: inFlight.runId };
			} catch (err) {
				// Best-effort cancel — the plan-run itself is already in the
				// cancelled state, and the child run will land terminally via
				// the bridge regardless. Surface the failure on the response
				// so operators can see why the child didn't cancel cleanly.
				deps.logger.warn(
					{
						planRunId: planRun.id,
						childRunId: inFlight.runId,
						err: err instanceof Error ? err.message : String(err),
					},
					"plan_run.cancel_child_failed",
				);
			}
		}

		return jsonResponse(200, {
			planRun: cancelled,
			cancelledChild,
			alreadyTerminal: false,
		});
	};
}

/**
 * `GET /plan-runs/:id/events` — NDJSON tail of the union of every child
 * run's events. Read-only: snapshots `events.listByRunIds(...)` first,
 * then subscribes to the broker for each child run. Live arrivals after
 * the snapshot are deduped by (runId, burrowEventSeq).
 *
 * `?follow=1` keeps the stream open until the client disconnects or the
 * plan-run reaches a terminal state. Default (no follow) returns the
 * snapshot then closes.
 */
function streamPlanRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const ctrl = bridgeAbort(ctx.request.signal);

		const source = tailPlanRunEvents({
			planRun,
			repos: deps.repos,
			broker: deps.broker,
			follow,
			signal: ctrl.signal,
		});
		return ndjsonResponse(asNdjsonStream(source, (row) => eventToNdjson(row, null), ctrl));
	};
}

interface TailPlanRunEventsInput {
	readonly planRun: { id: string };
	readonly repos: ServerDeps["repos"];
	readonly broker: ServerDeps["broker"];
	readonly follow: boolean;
	readonly signal: AbortSignal;
}

type PlanRunEventRow = {
	id: number;
	runId: string;
	burrowEventSeq: number;
	ts: string;
	kind: string;
	stream: string | null;
	payloadJson: unknown;
};

/**
 * Tail the union of every plan-run child's events. History first (via
 * `events.listByRunIds`), then live arrivals from `broker.subscribe(runId)`
 * for each known child runId. Newly-dispatched children are picked up by a
 * polling watcher so a stream opened before child 2 lands still sees its
 * events without a reconnect.
 *
 * Live events are deduped by (runId, burrowEventSeq) against the high-water
 * mark established during history replay, so a row that lands in the gap
 * between snapshot and subscribe isn't either dropped or duplicated.
 */
async function* tailPlanRunEvents(
	input: TailPlanRunEventsInput,
): AsyncGenerator<PlanRunEventRow, void, void> {
	const seenSeq = new Map<string, number>();

	const initialChildren = await input.repos.planRuns.listChildren(input.planRun.id);
	const initialRunIds = initialChildren.map((c) => c.runId).filter((v): v is string => v !== null);
	const history = await input.repos.events.listByRunIds(initialRunIds);
	for (const row of history) {
		const prev = seenSeq.get(row.runId) ?? 0;
		if (row.burrowEventSeq > prev) seenSeq.set(row.runId, row.burrowEventSeq);
		yield row;
	}

	if (!input.follow) return;

	// Shared event queue fed by every per-child subscription pump.
	const queue: PlanRunEventRow[] = [];
	let waiter: (() => void) | null = null;
	const wake = (): void => {
		const fn = waiter;
		if (fn !== null) {
			waiter = null;
			fn();
		}
	};
	input.signal.addEventListener("abort", wake, { once: true });

	const subscribed = new Set<string>();
	const subscribe = (runId: string): void => {
		if (subscribed.has(runId)) return;
		subscribed.add(runId);
		const sub = input.broker.subscribe(runId, { signal: input.signal });
		void (async () => {
			try {
				for await (const row of sub) {
					queue.push(row as PlanRunEventRow);
					wake();
				}
			} catch {
				// broker.subscribe ends via signal abort or close — ignore.
			}
		})();
	};
	for (const runId of initialRunIds) subscribe(runId);

	const watcherIntervalMs = 2_000;
	const watcher = setInterval(() => {
		void (async () => {
			try {
				const fresh = await input.repos.planRuns.listChildren(input.planRun.id);
				for (const child of fresh) {
					if (child.runId !== null) subscribe(child.runId);
				}
			} catch {
				// Best-effort — a missed reload pings again next tick.
			}
		})();
	}, watcherIntervalMs);

	try {
		while (!input.signal.aborted) {
			const row = queue.shift();
			if (row === undefined) {
				await new Promise<void>((resolve) => {
					waiter = resolve;
				});
				continue;
			}
			const prev = seenSeq.get(row.runId) ?? 0;
			if (row.burrowEventSeq <= prev) continue;
			seenSeq.set(row.runId, row.burrowEventSeq);
			yield row;
		}
	} finally {
		clearInterval(watcher);
	}
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
/* Plots                                                                    */
/* ----------------------------------------------------------------------- */

/**
 * `GET /plots?status=` — list Plot summaries aggregated across every
 * `hasPlot=true` project (warren-c167 / pl-9d6a step 2).
 *
 * Single-response JSON: no NDJSON envelope here — the list is bounded
 * by the number of Plots across all hasPlot projects (Plot SPEC notes
 * this is small-N relative to runs). The 5s in-memory cache lives
 * inside the aggregator (`src/plots/aggregate.ts`); successful list
 * calls never block on a fresh per-project rebuild.
 *
 * Empty-deployments contract (pinned by `28-plot-list-and-create.ts`
 * and the unit test below): when zero projects have `hasPlot=true` we
 * return the byte-identical empty array. `EMPTY_PLOT_SUMMARIES` is the
 * canonical reference so a non-Plot deployment that walks the API
 * surface sees a stable `200 []` response without any new bytes —
 * preserving the CLAUDE.md "opt-in built-in feature" framing.
 *
 * Status filter: validated against the `@os-eco/plot-cli`
 * `PLOT_STATUSES` whitelist so a typo doesn't silently return zero
 * results. Unknown status → `ValidationError` (→ 400 / `bad_request`).
 */
function listPlotsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const rawStatus = ctx.url.searchParams.get("status");
		const rawFilter = ctx.url.searchParams.get("filter");
		let status: PlotStatus | undefined;
		if (rawStatus !== null && rawStatus !== "") {
			if (!(PLOT_STATUSES as readonly string[]).includes(rawStatus)) {
				throw new ValidationError(
					`unknown status '${rawStatus}'; expected one of ${PLOT_STATUSES.join(", ")}`,
				);
			}
			status = rawStatus as PlotStatus;
		}
		// `?filter=needs_attention` (warren-d693 / pl-0344 step 9) routes
		// to the needs-attention scorer and returns rows carrying a
		// `reasons` array. `?status` + `?filter` compose: the status
		// filter is applied client-side on top of the needs-attention
		// set so a UI can render "drafting Plots in the Needs you view".
		if (rawFilter !== null && rawFilter !== "") {
			if (rawFilter !== "needs_attention") {
				throw new ValidationError(`unknown filter '${rawFilter}'; expected one of needs_attention`);
			}
			if (deps.plotAggregator === undefined) {
				return jsonResponse(200, { plots: [] as readonly PlotNeedsAttentionSummary[] });
			}
			const rows = await deps.plotAggregator.listNeedsAttention();
			const filtered = status !== undefined ? rows.filter((r) => r.status === status) : rows;
			return jsonResponse(200, { plots: filtered });
		}
		// Aggregator may be omitted by tests; fall back to the byte-identical
		// empty contract so the wire shape stays the same regardless.
		if (deps.plotAggregator === undefined) {
			return jsonResponse(200, { plots: EMPTY_PLOT_SUMMARIES });
		}
		const plots = await deps.plotAggregator.listSummaries(
			status !== undefined ? { status } : undefined,
		);
		return jsonResponse(200, { plots });
	};
}

/**
 * `GET /plots/needs-attention/count` — sidebar-badge counter for the
 * deployment-wide "Needs you" view (warren-d693 / pl-0344 step 9,
 * surfaced in the UI by warren-f0e2 / step 13).
 *
 * Returns `{ count: number }`. Deployments without `plotAggregator`
 * wired (the standalone-warren empty-deployment contract) return
 * `{ count: 0 }` — byte-stable for the no-Plot path.
 */
function needsAttentionCountHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		if (deps.plotAggregator === undefined) {
			return jsonResponse(200, { count: 0 });
		}
		const count = await deps.plotAggregator.countNeedsAttention();
		return jsonResponse(200, { count });
	};
}

/**
 * `POST /plots` — create a fresh Plot in the named project's `.plot/`
 * directory (warren-194e / pl-9d6a step 3).
 *
 * Handler order:
 *   (1) load project (NotFoundError → 404).
 *   (2) reject when `project.hasPlot === false` via typed
 *       `ProjectLacksPlotError` (mirrors POST /plan-runs' gate at
 *       mx-afe7e0 — same 400 envelope, stable `project_lacks_plot`
 *       code so HTTP consumers can branch).
 *   (3) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`
 *       rather than throwing.
 *   (4) parse + validate the body's optional `intent` patch shape.
 *   (5) hand off to `deps.plotCreator` (default `defaultPlotCreator`)
 *       which opens a `UserPlotClient` against `<project>/.plot/`,
 *       calls `PlotStore.create({name})`, optionally applies the
 *       intent patch via `editIntent`, and returns the per-project
 *       `CreatePlotResult`. **Not** fire-and-log — the user is
 *       waiting on the create result, so a failure here propagates
 *       synchronously to the HTTP response (mx-92e6b3 contrasts:
 *       PlanRun's plot-append IS fire-and-log because the user is
 *       waiting on the PlanRun, not the Plot mirror).
 *   (6) invalidate the aggregator's cache entry for the project so the
 *       next `GET /plots` (or `PlotResolver.resolve` for follow-up
 *       per-Plot handlers landing later in pl-9d6a) sees the fresh
 *       Plot without waiting for the 5s TTL.
 *   (7) return 201 with the full `PlotSummary` (per-project subset +
 *       `project_id` from the resolved row).
 *
 * Body shape: `{ project_id: string, name?: string, intent?: {
 *   goal?, non_goals?, constraints?, success_criteria? },
 *   dispatcher_handle?: string }`. `name` defaults to `"Untitled
 *   Plot"` when omitted so the UI's New-Plot dialog can ship a
 *   nameless draft (the user renames later via the per-Plot intent
 *   surface); explicit empty string is rejected since
 *   `PlotStore.create` requires non-empty.
 */
function createPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const projectId = requireString(body, "project_id");
		const rawName = optionalString(body, "name");
		if (rawName !== undefined && rawName.trim().length === 0) {
			throw new ValidationError("field 'name' must be a non-empty string when provided");
		}
		const name = rawName !== undefined ? rawName : "Untitled Plot";
		const dispatcherHandle = optionalString(body, "dispatcher_handle");
		const intent = parseIntentPatch(body.intent);

		// (1) project lookup — NotFoundError → 404.
		const project = await deps.repos.projects.require(projectId);

		// (2) hasPlot gate — typed error mirrors mx-afe7e0's shape.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} has no .plot/ directory; cannot create a Plot`,
				{
					recoveryHint:
						"run `plot init` in the project clone and refresh the project so warren picks up the .plot/ directory",
				},
			);
		}

		// (3) dispatcher handle resolution (mx-6a9788).
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (4/5) delegate to the creator seam.
		const creator = deps.plotCreator ?? defaultPlotCreator;
		const created = await creator.create({
			plotDir: join(project.localPath, ".plot"),
			handle,
			name,
			...(intent !== undefined ? { intent } : {}),
		});

		// (6) drop the aggregator's cache entry so subsequent reads see
		// the fresh Plot without waiting for the 5s TTL.
		deps.plotAggregator?.invalidate(project.id);

		// (7) wire response — PlotSummary shape.
		const summary: PlotSummary = {
			id: created.id,
			name: created.name,
			status: created.status,
			intent_goal_preview: created.intent_goal_preview,
			attachments_count: created.attachments_count,
			last_event_ts: created.last_event_ts,
			last_event_actor: created.last_event_actor,
			project_id: project.id,
		};
		return jsonResponse(201, summary);
	};
}

/**
 * Parse + validate the optional `intent` body field on `POST /plots`.
 * `null`/`undefined` → undefined (no patch). Anything else must be a
 * JSON object; unknown fields are rejected so a typo'd `goals`/`nongoals`
 * surfaces instead of silently dropping. List fields must be arrays of
 * non-empty strings.
 */
function parseIntentPatch(
	raw: unknown,
): import("../plots/index.ts").CreatePlotIntentPatch | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new ValidationError("field 'intent' must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["goal", "non_goals", "constraints", "success_criteria"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			throw new ValidationError(
				`field 'intent.${key}' is not recognized; expected one of goal, non_goals, constraints, success_criteria`,
			);
		}
	}
	const patch: {
		goal?: string;
		non_goals?: string[];
		constraints?: string[];
		success_criteria?: string[];
	} = {};
	if (obj.goal !== undefined) {
		if (typeof obj.goal !== "string") {
			throw new ValidationError("field 'intent.goal' must be a string");
		}
		patch.goal = obj.goal;
	}
	for (const key of ["non_goals", "constraints", "success_criteria"] as const) {
		const v = obj[key];
		if (v === undefined) continue;
		if (!Array.isArray(v) || v.some((item) => typeof item !== "string" || item.length === 0)) {
			throw new ValidationError(`field 'intent.${key}' must be an array of non-empty strings`);
		}
		patch[key] = v as string[];
	}
	return patch;
}

/**
 * `POST /brainstorm` — one-shot brainstorm dispatcher (warren-d22e /
 * pl-0344 step 8).
 *
 * Atomically creates a draft Plot (status defaults to `drafting`, empty
 * intent, name defaults to `"Untitled brainstorm"`) and dispatches the
 * first interactive turn against the built-in `brainstorm` agent bound
 * to that Plot. The two operations are exposed as separate primitives
 * (`POST /plots`, `POST /runs` with `mode='interactive'`) but the
 * fresh-start UX is a single click — wrapping them here saves the UI
 * an awkward two-call dance plus a partial-failure rollback.
 *
 * Body shape: `{ project_id: string, prompt: string, name?: string,
 *   agent?: string, dispatcher_handle?: string, providerOverride?,
 *   modelOverride?, ref? }`. `agent` overrides the default
 *   `"brainstorm"` so canopy-library variants can swap in by name; the
 *   override flows through warren's normal agent-resolution path.
 *
 * Handler order mirrors `POST /plots` then `POST /runs` (interactive):
 *   (1) project lookup + `hasPlot` gate (`ProjectLacksPlotError`).
 *   (2) dispatcher-handle resolution (mx-6a9788).
 *   (3) create the draft Plot via `deps.plotCreator`. Failure surfaces
 *       synchronously — the user is waiting on the result; we don't
 *       want a half-state where the run lands without a Plot.
 *   (4) build the first-turn prompt via `buildInteractivePrompt` (the
 *       same envelope `spawnInteractiveTurn` emits on turn N, so the
 *       agent sees a uniform shape across turn 1 and turn N).
 *   (5) `spawnRun({mode:'interactive', plotId: created.id, agentName})`.
 *   (6) `appendUserMessage` on the new run so the events stream
 *       reflects the conversation from turn 0.
 *   (7) start the bridge so events flow into warren immediately.
 *   (8) return 201 with `{plot, run, burrow}`.
 *
 * Aggregator cache is invalidated after the create so subsequent
 * `GET /plots` lists see the fresh Plot without waiting for the 5s
 * TTL.
 */
function createBrainstormHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const projectId = requireString(body, "project_id");
		const prompt = requireString(body, "prompt");
		const rawName = optionalString(body, "name");
		if (rawName !== undefined && rawName.trim().length === 0) {
			throw new ValidationError("field 'name' must be a non-empty string when provided");
		}
		const name = rawName !== undefined ? rawName : "Untitled brainstorm";
		const dispatcherHandle = optionalString(body, "dispatcher_handle");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const ref = optionalString(body, "ref");
		const agentName = optionalString(body, "agent") ?? "brainstorm";

		// (1) project + hasPlot gate.
		const project = await deps.repos.projects.require(projectId);
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} has no .plot/ directory; cannot start a brainstorm`,
				{
					recoveryHint:
						"run `plot init` in the project clone and refresh the project so warren picks up the .plot/ directory",
				},
			);
		}

		// (2) dispatcher-handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (3) create the draft Plot.
		const creator = deps.plotCreator ?? defaultPlotCreator;
		const created = await creator.create({
			plotDir: join(project.localPath, ".plot"),
			handle,
			name,
		});
		deps.plotAggregator?.invalidate(project.id);

		// (4) build first-turn prompt envelope. Best-effort context load —
		// a freshly-created Plot has no events yet, but we still go through
		// the same builder so the agent sees a uniform shape.
		let context = null;
		try {
			context = await defaultPlotContextReader.read({
				plotDir: join(project.localPath, ".plot"),
				plotId: created.id,
				historyTail: 0,
				handle,
			});
		} catch {
			// Best-effort; matches the createRunHandler interactive-first-turn
			// posture above.
		}
		const dispatchedPrompt = buildInteractivePrompt(context, prompt);

		// (5) dispatch the first interactive turn.
		const spawned = await spawnRun({
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			agentName,
			projectId,
			prompt: dispatchedPrompt,
			mode: "interactive",
			plotId: created.id,
			dispatcherHandle: handle,
			trigger: "brainstorm",
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			...(deps.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
				: {}),
			...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
		});

		// (6) append the raw user_message event on turn 0.
		await appendUserMessage({
			repos: deps.repos,
			runId: spawned.run.id,
			message: prompt,
			handle,
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});

		// (7) start the bridge so events flow into warren immediately.
		deps.bridges.start(spawned.run.id, spawned.burrowRun.id, spawned.burrow.id);

		// (8) wire response.
		const summary: PlotSummary = {
			id: created.id,
			name: created.name,
			status: created.status,
			intent_goal_preview: created.intent_goal_preview,
			attachments_count: created.attachments_count,
			last_event_ts: created.last_event_ts,
			last_event_actor: created.last_event_actor,
			project_id: project.id,
		};
		return jsonResponse(201, {
			plot: summary,
			run: spawned.run,
			burrow: {
				id: spawned.burrow.id,
				workspacePath: spawned.burrow.workspacePath,
			},
		});
	};
}

/**
 * `POST /plots/:id/formalize` — brainstorm-summarize endpoint
 * (warren-d22e / pl-0344 step 8).
 *
 * Returns a **suggested** Plot intent extracted from the agent's
 * messages in the brainstorm conversation. Non-mutating: the Plot is
 * untouched, no Plot event is emitted, no run is spawned. The caller
 * (UI) renders the suggestion as a form the user edits, then applies
 * via the existing `POST /plots/:id/intent` route and transitions to
 * `ready` via `POST /plots/:id/status`.
 *
 * Handler order:
 *   (1) resolve owning project via `deps.plotResolver`. `null` → typed
 *       404 so the empty-deployments contract stays stable.
 *   (2) defensive `hasPlot` re-check — the resolver only walks
 *       `hasPlot=true` rows, but the flag can flip out from under us.
 *   (3) hand off to `deps.plotFormalizer` (default
 *       `createDefaultPlotFormalizer({repos})`) which reads every
 *       `agent_message` event on interactive runs bound to the Plot,
 *       parses field markers, and returns the accumulated suggestion.
 *
 * Response shape: `{plot_id, suggested_intent: {goal, non_goals,
 *   constraints, success_criteria}, source_message_count}`. An
 *   all-empty suggestion + `source_message_count: 0` is the legitimate
 *   "no agent_message events yet" response — the UI shows "start
 *   chatting first" instead of an empty form.
 */
function formalizePlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");

		// (1) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (2) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot formalize plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (3) delegate to the formalizer seam.
		const formalizer = deps.plotFormalizer ?? createDefaultPlotFormalizer({ repos: deps.repos });
		const result = await formalizer.formalize({ plotId });
		return jsonResponse(200, result);
	};
}

/**
 * Resolve `paused_runs[]` for a Plot envelope (warren-4ea4 /
 * pl-0344 step 12). Each row is the narrow PlotDetail-facing subset:
 * `{run_id, paused_at, paused_question_event_id, pause_timeout_ms}`.
 * The timeout budget mirrors `resolveBudget()` in `src/runs/pause.ts`
 * — per-project `agent.pauseTimeoutMs` (via the WarrenConfigCache when
 * wired, else `loadWarrenConfig` direct read), falling back to
 * `DEFAULT_AGENT_PAUSE_TIMEOUT_MS` on any config error so the UI
 * countdown always has a number to anchor on.
 *
 * Rows missing `paused_at` or `paused_question_event_id` are skipped
 * defensively — the pause detector always stamps both on transition
 * (warren-2976), but a hand-crafted/malformed row should not crash the
 * envelope.
 */
async function loadPausedRunsForPlot(
	deps: ServerDeps,
	plotId: string,
	project: { id: string; localPath: string },
): Promise<
	Array<{
		run_id: string;
		paused_at: string;
		paused_question_event_id: string;
		pause_timeout_ms: number;
	}>
> {
	const rows = await deps.repos.runs.listByPlotId(plotId);
	const paused = rows.filter((r) => r.state === "paused");
	if (paused.length === 0) return [];
	let pauseTimeoutMs = DEFAULT_AGENT_PAUSE_TIMEOUT_MS;
	try {
		const cfg = await (deps.warrenConfigs !== undefined
			? deps.warrenConfigs.get(project.id, project.localPath)
			: loadWarrenConfig({ projectPath: project.localPath }));
		const value = cfg.defaults?.agent?.pauseTimeoutMs;
		if (typeof value === "number" && Number.isFinite(value)) pauseTimeoutMs = value;
	} catch {
		// fall through to default
	}
	const out: Array<{
		run_id: string;
		paused_at: string;
		paused_question_event_id: string;
		pause_timeout_ms: number;
	}> = [];
	for (const r of paused) {
		if (r.pausedAt === null || r.pausedQuestionEventId === null) continue;
		out.push({
			run_id: r.id,
			paused_at: r.pausedAt,
			paused_question_event_id: r.pausedQuestionEventId,
			pause_timeout_ms: pauseTimeoutMs,
		});
	}
	return out;
}

/**
 * `GET /plots/:id` — full Plot envelope by id (warren-961e /
 * pl-9d6a step 8).
 *
 * Handler order:
 *   (1) resolve the owning project via `deps.plotResolver`
 *       (built on top of `plotAggregator`'s per-project cache so the
 *       typical UI flow — `GET /plots` followed by `GET /plots/:id` —
 *       does at most one index read per project within the 5s TTL).
 *       `null` → typed 404. When no resolver is wired (non-Plot
 *       deployment), the handler also returns 404 so the
 *       empty-deployments contract stays stable.
 *   (2) defensive `hasPlot` re-check — the resolver only walks
 *       `hasPlot=true` projects, but the flag could have flipped
 *       between the aggregator's cached read and this lookup.
 *       Surface as `ProjectLacksPlotError` (same 400 envelope the
 *       create/dispatch paths use) so HTTP consumers see one stable
 *       `project_lacks_plot` code across handlers.
 *   (3) hand off to `deps.plotReader` (default `defaultPlotReader`),
 *       which opens a `UserPlotClient` against `<project>/.plot/`,
 *       snapshots `read()` + `events()` in parallel, and returns the
 *       per-project envelope subset. The handler stitches `project_id`
 *       on top to build the wire shape.
 *
 * `event_log` is returned in ascending `at` order — the reader sorts
 * defensively so the wire contract doesn't depend on the Plot
 * library's internal append order. The UI collapses long chains of
 * same-kind same-actor events client-side (see warren-bdbf).
 */
function getPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");

		// (1) resolve owning project. No resolver wired → 404 (same
		// posture as the byte-identical empty contract on GET /plots).
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (2) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot read plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (3) read full envelope.
		const reader = deps.plotReader ?? defaultPlotReader;
		const result = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
		});

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, envelope);
	};
}

/**
 * `GET /plots/:id/summary` — curated artifact view (warren-8917 /
 * pl-0344 step 15). Same resolver + reader stack as `GET /plots/:id`,
 * but the response is the institutional-memory projection produced by
 * `summarizePlot`: formatted intent, decisions filtered by
 * `decision_made`, linked PRs (with merge audit trail) + commits, and
 * a curated structural timeline. Pure derivation — no extra IO beyond
 * the reader.
 */
function getPlotSummaryHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot read plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}
		const reader = deps.plotReader ?? defaultPlotReader;
		const result = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
		});
		const artifact: PlotSummaryArtifact = summarizePlot({
			id: result.id,
			name: result.name,
			status: result.status,
			project_id: project.id,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
		});
		return jsonResponse(200, artifact);
	};
}

/**
 * `POST /plots/:id/intent` — edit a Plot's intent body (warren-896f /
 * pl-9d6a step 9).
 *
 * Handler order:
 *   (1) parse + validate the body's `intent` patch shape (reuses
 *       `parseIntentPatch` from `POST /plots` so the wire contract is
 *       symmetric — unknown fields like `goals`/`nongoals` reject at
 *       the handler edge).
 *   (2) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (3) resolve the owning project via `deps.plotResolver` (same
 *       cache-backed path as `GET /plots/:id`); `null` → 404. No
 *       resolver wired (non-Plot deployment) also → 404 so the
 *       empty-deployments contract stays stable.
 *   (4) defensive `hasPlot` re-check (the resolver only walks
 *       `hasPlot=true` rows, but the flag can flip out from under us
 *       between calls). Surface as `ProjectLacksPlotError` (400 /
 *       `project_lacks_plot`) for the same envelope the create /
 *       dispatch paths use.
 *   (5) hand off to `deps.plotIntentEditor` (default
 *       `defaultPlotIntentEditor`) which opens a `UserPlotClient`,
 *       enforces SPEC §6's frozen-at-done rule (`PlotIntentFrozenError`
 *       → 409 / `plot_intent_frozen`), applies the patch via
 *       `PlotHandle.editIntent`, and returns the fresh envelope subset.
 *       Failure propagates synchronously — NOT fire-and-log (mx-92e6b3
 *       contrasts: PlanRun's plot-append IS fire-and-log because the
 *       user is waiting on the PlanRun, not the Plot mirror; here the
 *       user is waiting on the intent edit itself).
 *   (6) invalidate the aggregator's cache entry for the project so a
 *       follow-up `GET /plots` sees the new `intent_goal_preview`
 *       without the 5s TTL wait.
 *   (7) return 200 with the full `PlotEnvelope` (per-project subset +
 *       `project_id` from the resolved row).
 *
 * Body shape: `{ goal?, non_goals?, constraints?, success_criteria?,
 *   dispatcher_handle? }`. An empty patch (all fields omitted) is
 * accepted as a no-op — the lib's `editIntent({})` short-circuits
 * without emitting an `intent_edited` event.
 *
 * ACL note: this handler uses `UserPlotClient` exclusively (via the
 * editor seam). `AgentPlotHandle` doesn't expose `editIntent` at the
 * type level (mx-bd4d67), so the agent-actor mistake is unreachable
 * from this code path at compile time.
 */
function editPlotIntentHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (1) parse the intent patch — flat top-level fields here (the
		// create endpoint wraps under `intent`, see parseIntentPatch).
		const patch = parseTopLevelIntentPatch(body);

		// (2) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (3) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (4) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot edit intent on plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (5) delegate to the editor seam.
		const editor = deps.plotIntentEditor ?? defaultPlotIntentEditor;
		const result = await editor.edit({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			patch: patch ?? {},
		});

		// (6) drop the aggregator cache so the next list sees the new
		// `intent_goal_preview` without waiting for the 5s TTL.
		deps.plotAggregator?.invalidate(project.id);

		// (7) wire response — full PlotEnvelope.
		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, envelope);
	};
}

/**
 * `POST /plots/:id/rename` — update a Plot's display name (warren-bed0 /
 * pl-b0c0 step 3).
 *
 * Handler order mirrors `editPlotIntentHandler`:
 *   (1) parse + validate `{name}` from the body (non-empty string after
 *       trim; unknown fields reject so typos surface). `dispatcher_handle`
 *       is accepted and threaded through but read separately.
 *   (2) resolve the dispatcher handle via `resolveDispatcherHandle`.
 *   (3) resolve the owning project via `deps.plotResolver`; `null` → 404.
 *   (4) defensive `hasPlot` re-check (→ 400 `project_lacks_plot`).
 *   (5) hand off to `deps.plotRenamer` (default `defaultPlotRenamer`),
 *       which opens a `UserPlotClient`, mutates `plot.json#/name`, and
 *       appends a `note` event recording the from→to transition.
 *       Failure surfaces synchronously — NOT fire-and-log.
 *   (6) invalidate the aggregator's cache entry for the project so a
 *       follow-up `GET /plots` sees the new name without the 5s TTL wait.
 *   (7) return 200 with the full `PlotEnvelope`.
 *
 * Renames are allowed in every status. The name is pure metadata — the
 * SPEC §6 frozen-at-done rule applies only to the intent body.
 */
function renamePlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (1) parse the rename body.
		const allowed = new Set(["name", "dispatcher_handle"]);
		for (const key of Object.keys(body)) {
			if (!allowed.has(key)) {
				throw new ValidationError(
					`field '${key}' is not recognized; expected one of name, dispatcher_handle`,
				);
			}
		}
		if (typeof body.name !== "string") {
			throw new ValidationError("field 'name' must be a string");
		}
		const trimmedName = body.name.trim();
		if (trimmedName.length === 0) {
			throw new ValidationError("field 'name' must be a non-empty string");
		}

		// (2) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (3) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (4) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot rename plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (5) delegate to the renamer seam.
		const renamer = deps.plotRenamer ?? defaultPlotRenamer;
		const result = await renamer.rename({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			name: trimmedName,
		});

		// (6) drop aggregator cache so a follow-up list sees the new name.
		deps.plotAggregator?.invalidate(project.id);

		// (7) wire response — full PlotEnvelope.
		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, envelope);
	};
}

/**
 * Parse + validate the top-level intent fields on `POST /plots/:id/intent`.
 * The wire contract here is flat (`{goal?, non_goals?, ..., dispatcher_handle?}`)
 * rather than the nested `{intent: {...}}` shape used by `POST /plots`,
 * matching the seed body verbatim. Unknown intent fields reject with 400 so
 * `goals`/`nongoals` typos surface; `dispatcher_handle` is ignored here (the
 * handler reads it separately). Identical field-typing rules as
 * `parseIntentPatch`: `goal` is a string; the three list fields are arrays
 * of non-empty strings.
 */
function parseTopLevelIntentPatch(
	body: Record<string, unknown>,
): import("../plots/index.ts").EditPlotIntentPatch | undefined {
	const allowed = new Set(["goal", "non_goals", "constraints", "success_criteria"]);
	const ignored = new Set(["dispatcher_handle"]);
	for (const key of Object.keys(body)) {
		if (allowed.has(key) || ignored.has(key)) continue;
		throw new ValidationError(
			`field '${key}' is not recognized; expected one of goal, non_goals, constraints, success_criteria, dispatcher_handle`,
		);
	}
	const patch: {
		goal?: string;
		non_goals?: string[];
		constraints?: string[];
		success_criteria?: string[];
	} = {};
	let hasField = false;
	if (body.goal !== undefined) {
		if (typeof body.goal !== "string") {
			throw new ValidationError("field 'goal' must be a string");
		}
		patch.goal = body.goal;
		hasField = true;
	}
	for (const key of ["non_goals", "constraints", "success_criteria"] as const) {
		const v = body[key];
		if (v === undefined) continue;
		if (!Array.isArray(v) || v.some((item) => typeof item !== "string" || item.length === 0)) {
			throw new ValidationError(`field '${key}' must be an array of non-empty strings`);
		}
		patch[key] = v as string[];
		hasField = true;
	}
	return hasField ? patch : undefined;
}

/**
 * `POST /plots/:id/status` — transition a Plot's status (warren-e868 /
 * pl-9d6a step 10).
 *
 * Handler order:
 *   (1) parse + validate the body's `next` field against
 *       `PLOT_STATUSES` (typo guard at the handler edge — same
 *       whitelist `GET /plots?status=` uses).
 *   (2) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (3) resolve the owning project via `deps.plotResolver`; `null`
 *       or unwired resolver → 404 (empty-deployments contract).
 *   (4) defensive `hasPlot` re-check — surfaces as
 *       `ProjectLacksPlotError` (400 / `project_lacks_plot`) for the
 *       same envelope the create / intent paths use.
 *   (5) hand off to `deps.plotStatusChanger` (default
 *       `defaultPlotStatusChanger`) which opens a `UserPlotClient`,
 *       runs the SPEC §6.5 transition matrix
 *       (`assertStatusTransitionAllowed`) against the on-disk current
 *       status, calls `setStatus(next)`, and snapshots the fresh
 *       summary + `status_changed` event. Failure propagates
 *       synchronously — NOT fire-and-log (mx-92e6b3 contrasts:
 *       PlanRun's plot-append IS fire-and-log because the user is
 *       waiting on the PlanRun, not the Plot mirror; here the user is
 *       waiting on the transition itself).
 *   (6) invalidate the aggregator cache entry for the project so a
 *       follow-up `GET /plots` sees the new status (and the
 *       refreshed `last_event_ts`/`last_event_actor`) without the 5s
 *       TTL wait.
 *   (7) return 200 with `{ summary: PlotSummary, event: PlotEvent }`
 *       — the UI splices `event` into the optimistic activity feed and
 *       reconciles the summary row against the next list response.
 *
 * Body shape: `{ next: 'drafting'|'ready'|'active'|'done'|'archived',
 *   dispatcher_handle? }`. Unknown body fields are ignored
 *   (forward-compatible with later additions like `reason`).
 *
 * ACL note: this handler uses `UserPlotClient` exclusively (via the
 * status-changer seam). `AgentPlotHandle` doesn't expose `setStatus`
 * at the type level (mx-bd4d67), so the agent-actor mistake is
 * unreachable from this code path at compile time.
 */
function changePlotStatusHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (1) parse + validate `next`.
		const rawNext = body.next;
		if (typeof rawNext !== "string") {
			throw new ValidationError("field 'next' must be a string");
		}
		if (!(PLOT_STATUSES as readonly string[]).includes(rawNext)) {
			throw new ValidationError(
				`unknown status '${rawNext}'; expected one of ${PLOT_STATUSES.join(", ")}`,
			);
		}
		const next = rawNext as PlotStatus;

		// (2) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (3) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (4) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot change status on plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (5) delegate to the changer seam. The changer reads the current
		// status from disk and re-runs `assertStatusTransitionAllowed`
		// before calling `setStatus`; warren never constructs an invalid
		// transition (defense in depth on top of the lib's own guard).
		const changer = deps.plotStatusChanger ?? defaultPlotStatusChanger;
		const result = await changer.change({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			next,
		});

		// (6) drop the aggregator cache so the next list sees the new
		// status / last_event_ts without waiting for the 5s TTL.
		deps.plotAggregator?.invalidate(project.id);

		// (7) wire response — PlotSummary + the emitted status_changed event.
		const summary: PlotSummary = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent_goal_preview: result.intent_goal_preview,
			attachments_count: result.attachments_count,
			last_event_ts: result.last_event_ts,
			last_event_actor: result.last_event_actor,
			project_id: project.id,
		};
		return jsonResponse(200, { summary, event: result.event });
	};
}

/**
 * Per-kind ref-shape patterns enforced at the handler edge (warren-589c).
 *
 * The lib only checks `ref.minLength >= 1`. Warren narrows this further
 * so typos / wrong-kind refs reject before the disk round-trip. Kinds
 * without a defined pattern fall through to the lib's min-length check.
 *
 * SPEC §3.1 leaves `ref` free-form, but the conventional shapes are
 * tractable:
 *   - `seeds_issue`  → `<project>-<4 hex>` (seeds id format).
 *   - `mulch_record` → `mx-<6 hex>` (mulch record id format).
 *   - `agent_run`    → `run-<...>` (warren run id format, prefix
 *                                      check only — the suffix shape
 *                                      varies across deployments).
 *   - `gh_pr`        → free-form (PRs use full URLs / owner/repo#N).
 *   - `gh_issue`     → free-form (same).
 *   - `file`         → free-form (paths are arbitrary).
 */
const ATTACHMENT_REF_PATTERNS: Partial<Record<AttachmentType, RegExp>> = {
	seeds_issue: /^[a-z0-9_-]+-[a-f0-9]{4}$/,
	mulch_record: /^mx-[a-f0-9]{6}$/,
	agent_run: /^run-[A-Za-z0-9_-]+$/,
};

/**
 * `POST /plots/:id/attachments` — attach an external reference to a
 * Plot (warren-589c / pl-9d6a step 11).
 *
 * Handler order:
 *   (1) parse + validate `kind` against `ATTACHMENT_TYPES` (the lib's
 *       enum). The seed body lists six wire kinds; the lib's enum is
 *       the source of truth, so kinds outside
 *       `seeds_issue|mulch_record|agent_run|gh_pr|gh_issue|file` are
 *       rejected with 400. Per-kind ref shape is then validated via
 *       `ATTACHMENT_REF_PATTERNS` (e.g. `seeds_issue` ref matches
 *       `/^[a-z0-9_-]+-[a-f0-9]{4}$/`).
 *   (2) parse + validate `ref` (non-empty string) and the optional
 *       `role` (non-empty string when present).
 *   (3) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (4) resolve the owning project via `deps.plotResolver`; `null` or
 *       unwired resolver → 404 (empty-deployments contract).
 *   (5) defensive `hasPlot` re-check — surfaces as
 *       `ProjectLacksPlotError` (400 / `project_lacks_plot`) for
 *       parity with the create / intent / status paths.
 *   (6) hand off to `deps.plotAttacher` (default `defaultPlotAttacher`)
 *       which opens a `UserPlotClient` and calls `PlotHandle.attach`.
 *       Failure propagates synchronously — NOT fire-and-log.
 *   (7) invalidate the aggregator cache entry for the project so a
 *       follow-up `GET /plots` sees the new `attachments_count`
 *       without the 5s TTL wait.
 *   (8) return 200 with `{ envelope: PlotEnvelope, attachment: Attachment }`
 *       so the UI can splice the new attachment into its optimistic
 *       state without re-rendering the entire envelope.
 *
 * ACL note: `UserPlotClient` exclusively (via the attacher seam).
 * Agent actors are not routed through this handler — see SPEC §6 —
 * but `attach` is permitted on `AgentPlotHandle` too; threading the
 * write through the user-typed seam keeps the actor on the wire log
 * consistent with the intent/status writes.
 */
function attachPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (1) parse + validate `kind`.
		const rawKind = body.kind;
		if (typeof rawKind !== "string") {
			throw new ValidationError("field 'kind' must be a string");
		}
		if (!(ATTACHMENT_TYPES as readonly string[]).includes(rawKind)) {
			throw new ValidationError(
				`unknown kind '${rawKind}'; expected one of ${ATTACHMENT_TYPES.join(", ")}`,
			);
		}
		const kind = rawKind as AttachmentType;

		// (2) parse + validate `ref` and `role`.
		const rawRef = body.ref;
		if (typeof rawRef !== "string" || rawRef.length === 0) {
			throw new ValidationError("field 'ref' must be a non-empty string");
		}
		const refPattern = ATTACHMENT_REF_PATTERNS[kind];
		if (refPattern !== undefined && !refPattern.test(rawRef)) {
			throw new ValidationError(
				`field 'ref' does not match the expected shape for kind '${kind}' (pattern: ${refPattern.source})`,
			);
		}
		let role: string | undefined;
		if (body.role !== undefined) {
			if (typeof body.role !== "string" || body.role.length === 0) {
				throw new ValidationError("field 'role' must be a non-empty string when present");
			}
			role = body.role;
		}

		// (3) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (4) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (5) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot attach to plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (6) delegate to the attacher seam.
		const attacher = deps.plotAttacher ?? defaultPlotAttacher;
		const result = await attacher.attach({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			kind,
			ref: rawRef,
			...(role !== undefined ? { role } : {}),
		});

		// (7) drop the aggregator cache so the next list sees the new
		// attachments_count / last_event_ts without waiting for the 5s TTL.
		deps.plotAggregator?.invalidate(project.id);

		// (8) wire response — full PlotEnvelope + the freshly added attachment.
		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, { envelope, attachment: result.attachment });
	};
}

/**
 * `DELETE /plots/:id/attachments/:ref` — detach an external reference
 * from a Plot (warren-589c / pl-9d6a step 11).
 *
 * Handler order:
 *   (1) decode the `:ref` URL param (the router already runs
 *       `decodeURIComponent` per `src/server/router.ts`) and reject
 *       empty refs at the edge.
 *   (2) parse the optional `dispatcher_handle` from the request body
 *       (DELETE bodies are spec-legal under fetch and Bun.serve). When
 *       no body is provided we accept that and fall through to the
 *       `operator` fallback.
 *   (3) resolve the dispatcher handle via `resolveDispatcherHandle`.
 *   (4) resolve the owning project via `deps.plotResolver`; `null` or
 *       unwired resolver → 404 (empty-deployments contract).
 *   (5) defensive `hasPlot` re-check — `ProjectLacksPlotError` (400).
 *   (6) hand off to `deps.plotAttacher.detach` (default
 *       `defaultPlotAttacher`) which reads the Plot, maps the ref to
 *       the lib's `att-NNN` id, and calls `PlotHandle.detach`.
 *       `PlotAttachmentNotFoundError` (404) surfaces when the ref
 *       doesn't match any current attachment.
 *   (7) invalidate the aggregator cache entry for the project.
 *   (8) return 200 with `{ envelope: PlotEnvelope, removed_id }`.
 */
function detachPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const ref = requireParam(ctx, "ref");
		if (ref.length === 0) {
			throw new ValidationError("path param ':ref' must be a non-empty string");
		}

		// (2) optional body. DELETE bodies are rare — readJsonBodyOrEmpty
		// returns null for empty payloads so the call stays optional.
		const body = await readJsonBodyOrEmpty(ctx);
		const dispatcherHandle = body !== null ? optionalString(body, "dispatcher_handle") : undefined;

		// (3) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (4) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (5) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot detach from plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (6) delegate to the attacher seam.
		const attacher = deps.plotAttacher ?? defaultPlotAttacher;
		const result = await attacher.detach({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			ref,
		});

		// (7) drop the aggregator cache.
		deps.plotAggregator?.invalidate(project.id);

		// (8) wire response — full PlotEnvelope + the removed attachment id.
		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, { envelope, removed_id: result.removed_id });
	};
}

/**
 * `POST /plots/:id/attachments/:ref/merge` — click-to-merge a
 * GitHub PR attachment (warren-8e39 / pl-0344 step 14).
 *
 * Handler order:
 *   (1) decode `:ref` (router runs decodeURIComponent) and reject
 *       empty refs at the edge.
 *   (2) optional body parses `dispatcher_handle` + `merge_method`
 *       (‘merge’ | ‘squash’ | ‘rebase’, default ‘merge’).
 *   (3) handle resolution via `resolveDispatcherHandle`.
 *   (4) resolve owning project via `deps.plotResolver`; `null` /
 *       unwired → 404.
 *   (5) defensive `hasPlot` re-check → `ProjectLacksPlotError`.
 *   (6) `deps.plotPrMerger.merge` resolves the gh_pr attachment,
 *       parses the ref, calls `mergePullRequest` against the GitHub
 *       REST API, and returns the post-merge Plot snapshot + the
 *       `MergePullRequestResult` variant. Errors:
 *         - `PlotAttachmentNotFoundError` (404) — unknown ref
 *         - `PlotPrAttachmentMismatchedKindError` (400) — wrong kind
 *         - `PlotPrAttachmentInvalidError` (400) — unparseable ref
 *   (7) on `merge.kind === "merged" | "already_merged"` schedule a
 *       background `refreshProject` so the local clone picks up the
 *       new merge commit. Fire-and-forget with structured-logger
 *       error handling — the wire response does NOT block on the
 *       refresh, the UI gets the merge outcome immediately and the
 *       follow-up clone state lands via the existing
 *       `last_refreshed_at` field on the project row (refreshed via
 *       the standard `/projects/:id/refresh` cycle, just kicked
 *       early here).
 *   (8) invalidate the aggregator cache entry for the project (the
 *       fresh event log on the envelope reflects any post-merge
 *       gardening the lib does).
 *   (9) return 200 with `{ envelope, merge, attachment_id,
 *       refresh_scheduled }`. The `merge` variant is surfaced
 *       verbatim so the UI renders rate-limit + error states
 *       without re-parsing the envelope.
 *
 * GitHub auth: `deps.autoOpenPr.token` already carries `GITHUB_TOKEN`
 * (same source the reap path uses for PR open). Tokenless
 * deployments surface `merge.kind === "missing_token"` so the UI
 * can hint the operator at the env var.
 */
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
type MergeMethod = (typeof MERGE_METHODS)[number];

function mergePlotPrAttachmentHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const ref = requireParam(ctx, "ref");
		if (ref.length === 0) {
			throw new ValidationError("path param ':ref' must be a non-empty string");
		}

		const body = await readJsonBodyOrEmpty(ctx);
		const dispatcherHandle = body !== null ? optionalString(body, "dispatcher_handle") : undefined;
		let mergeMethod: MergeMethod | undefined;
		if (body !== null && body.merge_method !== undefined) {
			const raw = body.merge_method;
			if (typeof raw !== "string" || !(MERGE_METHODS as readonly string[]).includes(raw)) {
				throw new ValidationError(
					`field 'merge_method' must be one of ${MERGE_METHODS.join(", ")} when present`,
				);
			}
			mergeMethod = raw as MergeMethod;
		}

		const handle = resolveDispatcherHandle(dispatcherHandle);

		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot merge attachment on plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		const merger = deps.plotPrMerger ?? defaultPlotPrMerger;
		const token = deps.autoOpenPr?.token ?? "";
		const result = await merger.merge({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			ref,
			token,
			...(mergeMethod !== undefined ? { mergeMethod } : {}),
		});

		let refreshScheduled = false;
		if (result.merge.kind === "merged" || result.merge.kind === "already_merged") {
			refreshScheduled = true;
			// Fire-and-forget background refresh so the local clone picks up
			// the new merge commit. The user already has the merge outcome
			// on the response; this is a follow-up sync.
			const projectId = project.id;
			void refreshProject({
				repo: deps.repos.projects,
				config: deps.projectsConfig,
				id: projectId,
				spawn: deps.spawn ?? defaultSpawn,
				...(deps.now !== undefined ? { now: deps.now } : {}),
				...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			})
				.then((res) => {
					deps.logger.info(
						{ projectId, headSha: res.headSha, plotId, ref },
						"background project refresh after PR merge",
					);
				})
				.catch((err: unknown) => {
					deps.logger.warn(
						{
							projectId,
							plotId,
							ref,
							err: err instanceof Error ? err.message : String(err),
						},
						"background project refresh after PR merge failed",
					);
				});
		}

		deps.plotAggregator?.invalidate(project.id);

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, {
			envelope,
			merge: result.merge,
			attachment_id: result.attachment_id,
			refresh_scheduled: refreshScheduled,
		});
	};
}

/**
 * `POST /plots/:id/questions/:event_id/answer` — answer a `question_posed`
 * event with a `question_answered` event (warren-e1ac / pl-9d6a step 12).
 *
 * The wire `:event_id` is the `at` ISO timestamp of the targeted
 * `question_posed` event. PlotEvent has no synthetic id; `at` is the
 * stable identifier the UI feeds back after reading the event log.
 *
 * Handler order:
 *   (1) decode `:event_id` (the router runs `decodeURIComponent`) and
 *       reject empty values at the edge.
 *   (2) parse + validate the body's `answer` field (non-empty string).
 *       `dispatcher_handle` resolution via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (3) resolve the owning project via `deps.plotResolver`; `null` or
 *       unwired resolver → 404 (empty-deployments contract).
 *   (4) defensive `hasPlot` re-check — surfaces as
 *       `ProjectLacksPlotError` (400 / `project_lacks_plot`) for parity
 *       with the create / intent / status / attach paths.
 *   (5) hand off to `deps.plotQuestionAnswerer` (default
 *       `defaultPlotQuestionAnswerer`). The answerer re-validates the
 *       handler-edge concurrency invariant against the fresh on-disk
 *       event log (the targeted `question_posed` still exists AND has
 *       no subsequent `question_answered` referencing it) and appends
 *       the `question_answered` event via the typed `UserPlotClient`.
 *       Failure propagates synchronously — NOT fire-and-log; the user
 *       is waiting on the answer submit.
 *   (6) invalidate the aggregator cache entry for the project so a
 *       follow-up `GET /plots` sees the refreshed `last_event_ts` /
 *       `last_event_actor` without the 5s TTL wait.
 *   (7) return 200 with `{ event: PlotEvent }` — the freshly appended
 *       `question_answered` event for the UI to splice into the
 *       optimistic activity feed; the next `GET /plots/:id` reconciles
 *       the rest of the envelope.
 *
 * ACL note: this handler uses `UserPlotClient` exclusively (via the
 * answerer seam). `question_answered` is one of the four humans-only
 * event types per SPEC §6 — `AgentPlotHandle.append` excludes it at
 * the type level (mx-bd4d67), so the agent-actor mistake is
 * unreachable from this code path at compile time.
 */
function answerPlotQuestionHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const eventId = requireParam(ctx, "event_id");
		if (eventId.length === 0) {
			throw new ValidationError("path param ':event_id' must be a non-empty string");
		}

		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (2) parse + validate `answer`.
		const rawAnswer = body.answer;
		if (typeof rawAnswer !== "string" || rawAnswer.length === 0) {
			throw new ValidationError("field 'answer' must be a non-empty string");
		}

		// handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (3) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (4) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot answer question on plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (5) delegate to the answerer seam. The answerer re-reads the
		// event log and re-runs `assertQuestionAnswerable` against the
		// fresh on-disk state before calling `append` — the lib
		// guarantees neither half of the invariant, so warren owns it.
		const answerer = deps.plotQuestionAnswerer ?? defaultPlotQuestionAnswerer;
		const result = await answerer.answer({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			eventId,
			answer: rawAnswer,
		});

		// (6) drop the aggregator cache so the next list sees the
		// refreshed last_event_ts / last_event_actor without the 5s TTL.
		deps.plotAggregator?.invalidate(project.id);

		// (7) wire response — just the freshly appended event for
		// optimistic UI splice.
		return jsonResponse(200, { event: result.event });
	};
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

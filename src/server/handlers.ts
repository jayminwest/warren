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
import { PLOT_STATUSES, type PlotStatus } from "@os-eco/plot-cli";
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
import {
	defaultPlotCreator,
	defaultPlotReader,
	EMPTY_PLOT_SUMMARIES,
	type PlotEnvelope,
	type PlotSummary,
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
	cancelRun,
	resolveDispatcherHandle,
	spawnRun,
	steerRun,
	tailRunEvents,
} from "../runs/index.ts";
import { showPlan, showSeed } from "../seeds-cli/index.ts";
import { buildTriggerSummaries, parseCron, resolveCronPrompt } from "../triggers/index.ts";
import {
	type CronTrigger,
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

function listRunsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const project = ctx.url.searchParams.get("project");
		const agent = ctx.url.searchParams.get("agent");
		if (project !== null && agent !== null) {
			throw new ValidationError("filter by either ?project=... or ?agent=..., not both");
		}
		const order = parseRunsSort(ctx);
		if (project !== null) {
			return jsonResponse(200, { runs: await deps.repos.runs.listByProject(project, order) });
		}
		if (agent !== null) {
			return jsonResponse(200, { runs: await deps.repos.runs.listByAgent(agent, order) });
		}
		return jsonResponse(200, { runs: await deps.repos.runs.listAll(order) });
	};
}

function getRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		return jsonResponse(200, await deps.repos.runs.require(id));
	};
}

function createRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const ref = optionalString(body, "ref");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const seedId = optionalString(body, "seedId");
		const plotId = optionalString(body, "plotId");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		const result = await spawnRun({
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			agentName: requireString(body, "agent"),
			projectId: requireString(body, "project"),
			prompt: requireString(body, "prompt"),
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
		let status: PlotStatus | undefined;
		if (rawStatus !== null && rawStatus !== "") {
			if (!(PLOT_STATUSES as readonly string[]).includes(rawStatus)) {
				throw new ValidationError(
					`unknown status '${rawStatus}'; expected one of ${PLOT_STATUSES.join(", ")}`,
				);
			}
			status = rawStatus as PlotStatus;
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

		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
		};
		return jsonResponse(200, envelope);
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
	{ method: "POST", pattern: "/runs/:id/steer", build: steerRunHandler },
	{ method: "POST", pattern: "/runs/:id/cancel", build: cancelRunHandler },
	{ method: "GET", pattern: "/runs/:id/preview/login", build: previewLoginHandler },
	{ method: "POST", pattern: "/runs/:id/preview/teardown", build: previewTeardownHandler },

	{ method: "GET", pattern: "/preview/config", build: previewConfigHandler },

	{ method: "GET", pattern: "/plan-runs", build: listPlanRunsHandler },
	{ method: "POST", pattern: "/plan-runs", build: createPlanRunHandler },
	{ method: "GET", pattern: "/plan-runs/:id", build: getPlanRunHandler },
	{ method: "POST", pattern: "/plan-runs/:id/cancel", build: cancelPlanRunHandler },
	{ method: "GET", pattern: "/plan-runs/:id/events", build: streamPlanRunEventsHandler },

	{ method: "GET", pattern: "/plots", build: listPlotsHandler },
	{ method: "POST", pattern: "/plots", build: createPlotHandler },
	{ method: "GET", pattern: "/plots/:id", build: getPlotHandler },
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
	"/burrows",
	"/projects",
	"/runs",
	"/workers",
	"/healthz",
	"/readyz",
	"/version",
	"/preview",
	"/plan-runs",
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

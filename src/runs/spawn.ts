/**
 * `spawnRun` — the §4.3 composition flow.
 *
 * One call drives the three-step ritual that turns "the operator picked
 * an agent + project + prompt" into "burrow has a queued run":
 *
 *   1. Resolve the cached agent definition (registry refresh seeded it
 *      via `cn render`). The rendered envelope is what gets frozen onto
 *      `runs.rendered_agent_json` — re-rendering at run time is
 *      deliberately not done here. Operators trigger a fresh render via
 *      `POST /agents/refresh` if they want one.
 *
 *   2. Provision a burrow via `POST /burrows`, deriving the request body
 *      from the project clone (`projectRoot`, `originUrl`) and the
 *      agent's `burrow_config` (`network`). The `.canopy/`, `.mulch/`,
 *      `.seeds/`, `.pi/` workspace drops (see `./seed.ts`) ride along as
 *      the `seed.files` payload so provisioning + seeding land in a
 *      single atomic round-trip — burrow rolls the burrow back on its
 *      side if any seed file fails validation (R-07).
 *
 *   3. Dispatch via `POST /burrows/:id/runs`.
 *
 * Placement (warren-39c3 / pl-9ba1 step 4): `BurrowClientPool.placeFor`
 * picks a worker BEFORE the warren row is created so `runs.worker_id`
 * lands at row-creation time and the same `BurrowClient` services
 * provision, dispatch, and rollback. A `burrows` row capturing the
 * burrow → worker pinning is written in the same turn as
 * `attachBurrow`, so sticky-by-burrow (cancel / steer / reap / fan-out
 * reads via `pool.clientFor`) has a durable mapping to resolve against.
 *
 * The warren run row is created BEFORE any burrow call, with both
 * burrow IDs nulled — `attachBurrow` writes them back as each call
 * succeeds. That lets us carry the warren `run_xxx` id through the
 * flow (so log lines, error messages, and event payloads can reference
 * it) without a chicken-and-egg between the two systems' IDs.
 *
 * Failure handling:
 *   - Anything before step 2 (agent/project lookup, agent JSON
 *     re-validation, seed-payload validation) just throws — no warren
 *     row was created.
 *   - Failures from step 2 onward are caught: the warren row is
 *     transitioned `queued → cancelled` (allowed by the runs state
 *     machine), and if a burrow was provisioned we best-effort destroy
 *     it so it doesn't sit as a stranded sandbox. A seed-validation
 *     failure inside `burrows.up` rolls back on burrow's side before
 *     warren ever observes a burrow id — `burrow` stays `null` so no
 *     destroy call fires. The original error is rethrown so the caller
 *     (HTTP route, CLI) can surface it.
 */

import { join } from "node:path";
import type {
	Burrow,
	Run as BurrowRun,
	HttpWorkspaceFile,
	NetworkPolicy,
} from "@os-eco/burrow-cli";
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunMode, RunRow } from "../db/schema.ts";
import { UserPlotClient } from "../plot-client/index.ts";
import type { SpawnFn as ProjectSpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { refreshProject } from "../projects/manage.ts";
import {
	type AgentDefinition,
	parseRenderedAgent,
	RenderResponseSchema,
	readRuntimeId,
	withProviderOverrides,
} from "../registry/schema.ts";
import {
	type SeedsCliDeps,
	updateExtensions,
	type WarrenExtensions,
	WarrenTriggerKind,
} from "../seeds-cli/index.ts";
import type { DefaultsConfig, WarrenConfigCache } from "../warren-config/index.ts";
import { composeRunBranch, resolveRunBranchPrefix } from "./branch.ts";
import { parseBurrowConfig } from "./burrow_config.ts";
import { RunSpawnError } from "./errors.ts";
import { buildSeedFiles } from "./seed.ts";

export interface SpawnRunInput {
	readonly repos: Repos;
	/**
	 * Multi-worker successor to the legacy `burrowClient` parameter
	 * (warren-39c3 / pl-9ba1 step 4, parent warren-6747). `spawnRun`
	 * resolves placement via `pool.placeFor({projectId})` so the chosen
	 * worker name lands on `runs.worker_id` AND `burrows.worker_id`
	 * before any burrow HTTP call. The same client services provision +
	 * dispatch + rollback so a single run never crosses workers.
	 */
	readonly burrowClientPool: BurrowClientPool;
	readonly agentName: string;
	readonly projectId: string;
	readonly prompt: string;
	readonly trigger?: string;
	/**
	 * Optional seeds issue id this run was dispatched against (pl-bb70
	 * step 3, warren-805a). Persisted on the runs row as `seed_id`, so
	 * the post-dispatch `updateExtensions` write (pl-bb70 step 4) has a
	 * seed to merge `{role, trigger, lastRunId, lastRunAt}` into and the
	 * Run API can surface a back-link on RunDetail (pl-bb70 step 6).
	 * Manual prompts and legacy callers leave it undefined → null on disk.
	 */
	readonly seedId?: string;
	/**
	 * Run mode (pl-0344 step 1 / warren-67b6; surfaced by step 3 / warren-1117).
	 * `batch` (default) is the historical single-shot run; `interactive` is the
	 * respawn-per-turn primitive used by `spawnInteractiveTurn` in
	 * `./interactive.ts`. Persisted to `runs.mode` and fixed at row creation;
	 * forwarded onto the burrow up call unchanged (burrow has no notion of
	 * mode — the discriminator is warren-side only).
	 */
	readonly mode?: RunMode;
	/**
	 * Optional Plot id this run is dispatched against (warren-a8c3,
	 * parent warren-000b). Validated against `project.hasPlot` here:
	 * passing a plot_id for a project whose clone has no `.plot/`
	 * directory raises a typed ValidationError so the operator gets a
	 * 400 with a clear hint instead of a silently-dropped field.
	 * Persisted to `runs.plot_id`; downstream steps (warren-e26f,
	 * warren-e848, warren-7e0f) read it from the runs row.
	 */
	readonly plotId?: string;
	readonly metadata?: unknown;
	/**
	 * Optional per-run override of the agent's `frontmatter.provider`. When
	 * set (and non-empty), the spawn composer folds it onto the frozen
	 * agent definition before persisting `runs.rendered_agent_json`. Empty
	 * / whitespace-only values are ignored — same shape as `ref`.
	 */
	readonly providerOverride?: string;
	/** Optional per-run override of the agent's `frontmatter.model`. */
	readonly modelOverride?: string;
	readonly now?: () => Date;
	/**
	 * Refresh the project's on-disk clone before provisioning burrow.
	 * Without this, every run reuses the registration-time commit
	 * forever (warren-1bb6). Required for spawnRun to pick up new
	 * commits without DELETE + POST /projects.
	 *
	 * Skipped if `projectsConfig` and `projectSpawn` aren't both wired.
	 * Tests that don't care about refresh can leave them off; the HTTP
	 * server passes both.
	 */
	readonly projectsConfig?: ProjectsConfig;
	readonly projectSpawn?: ProjectSpawnFn;
	/** Branch, tag, or SHA to refresh to. Defaults to the project's tracked default branch. */
	readonly ref?: string;
	/** Override the project refresher; defaults to `refreshProject`. */
	readonly refreshProjectFn?: typeof refreshProject;
	/**
	 * Optional warren-config cache. Forwarded into the pre-spawn refresh
	 * so a run that updates the working tree also invalidates any cached
	 * `.warren/` envelope (pl-5d74 risk #4). Tests that don't exercise
	 * the cache can omit.
	 */
	readonly warrenConfigs?: WarrenConfigCache;
	/**
	 * Deployment-wide run-branch prefix fallback (warren-9993), resolved
	 * from `WARREN_RUN_BRANCH_PREFIX` by the caller. Project-default
	 * (`.warren/defaults.json.runBranchPrefix`) wins over this when both
	 * are set; if neither is set, spawnRun falls back to "burrow" so
	 * existing deployments are unchanged.
	 */
	readonly runBranchPrefixDefault?: string;
	/**
	 * Seeds CLI shell-out deps for the post-dispatch extension write
	 * (pl-bb70 step 4, warren-46cd). When both `seedId` and this are
	 * provided, spawnRun fires a single `sd update --extensions` after
	 * `attachBurrow(burrowRunId)` succeeds, merging `{role, trigger,
	 * lastRunId, lastRunAt}` onto the seed. Failure is fire-and-log
	 * (mirrors the pl-2f15 risk #4 mitigation in src/triggers/tick.ts):
	 * a `seeds_extension_write_failed` system event lands on the run,
	 * the run does NOT roll back. Omit on call sites that don't ship a
	 * project clone (CLI run, tests) — without it, the extension write
	 * is a no-op even when seedId is set.
	 */
	readonly seedsCli?: SeedsCliDeps;
	/**
	 * Handle of the user dispatching the run (warren-e848 / pl-2047 step 5).
	 * Used as the actor for the `run_dispatched` event appended to the
	 * originating Plot — Plot's SPEC §6 ACL allows both `user:*` and
	 * `agent:*` actors for `run_dispatched`, but warren attributes the
	 * dispatch to the human who triggered it. Falls back to
	 * `DEFAULT_DISPATCHER_HANDLE` when undefined, empty, or doesn't match
	 * the actor segment regex — non-user dispatch paths (cron/webhook)
	 * are accounted for under pl-2047 risk #4.
	 */
	readonly dispatcherHandle?: string;
	/**
	 * Test seam for the `run_dispatched` Plot append (warren-e848). The
	 * default opens a `UserPlotClient` against `<project>/.plot/` and
	 * fire-and-logs on failure; tests substitute a stub to assert the
	 * payload without touching disk.
	 */
	readonly plotAppender?: SpawnPlotAppender;
}

/**
 * Default user handle used for the `run_dispatched` Plot event when the
 * caller doesn't supply one. Warren has no first-class user-auth surface
 * today (pl-2047 risk #4); a fixed fallback keeps the Plot's event log
 * well-formed and matches the `user:<handle>` actor regex.
 */
export const DEFAULT_DISPATCHER_HANDLE = "operator";

/**
 * Actor segment regex copied from `@os-eco/plot-cli`'s actor.ts:
 * `[A-Za-z0-9][A-Za-z0-9_-]*`. A handle that fails this check is
 * downgraded to `DEFAULT_DISPATCHER_HANDLE` rather than throwing — the
 * append is fire-and-log, and a malformed operator-supplied handle
 * shouldn't be the reason a dispatch's Plot record is missing.
 */
const ACTOR_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface AppendPlotRunDispatchedInput {
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	readonly runId: string;
	readonly agentName: string;
	readonly model: string | null;
	readonly projectId: string;
}

export interface SpawnPlotAppender {
	appendRunDispatched(input: AppendPlotRunDispatchedInput): Promise<void>;
}

export interface SpawnRunResult {
	readonly run: RunRow;
	readonly burrow: Burrow;
	readonly burrowRun: BurrowRun;
	readonly agent: AgentDefinition;
}

export async function spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
	if (input.prompt.trim() === "") {
		throw new ValidationError("prompt cannot be empty");
	}

	// R-03 (pl-fef5 step 7): prefer the project tier when a project-scoped
	// row exists, fall back to the global (built-in + library) tier otherwise.
	// `resolve` returns null on both misses; re-raise as the same NotFoundError
	// shape `require` used to so HTTP/CLI error envelopes (incl. the
	// `POST /agents/refresh` recovery hint) stay intact.
	const agentRow = await input.repos.agents.resolve(input.agentName, {
		projectId: input.projectId,
	});
	if (!agentRow) {
		throw new NotFoundError(`agent not found: ${input.agentName}`, {
			recoveryHint: "POST /agents/refresh to re-discover from canopy",
		});
	}
	const project = await input.repos.projects.require(input.projectId);
	// warren-a8c3: gate plot_id on the project's hasPlot flag. Probed at
	// addProject / refreshProjectClone time (warren-4e20). Refusing here
	// keeps the runs row honest — a non-Plot project never grows a
	// dangling plot_id that downstream PLOT_ID env injection (warren-e26f)
	// or .plot/ mirroring (warren-7e0f) would have to second-guess.
	if (input.plotId !== undefined && input.plotId !== "" && !project.hasPlot) {
		throw new ValidationError(
			`project ${project.id} has no .plot/ directory; plot_id is not accepted`,
			{
				recoveryHint:
					"either omit plot_id on POST /runs, or run `plot init` in the project clone and refresh the project so warren picks up the .plot/ directory",
			},
		);
	}
	const baseAgent = readCachedAgent(agentRow.renderedJson, agentRow.name);
	const burrowConfig = parseBurrowConfig(baseAgent.sections.burrow_config);

	// Refresh the project clone to origin/<ref> so the run sees the
	// latest commits. Skipped only when the caller didn't wire the
	// projects-config + spawn seam (tests that pre-stage their own
	// fixtures). Refresh failure aborts the spawn before we create a
	// warren row — a stale workspace is worse than a clean error
	// (warren-1bb6).
	const refreshed =
		input.projectsConfig !== undefined && input.projectSpawn !== undefined
			? await (input.refreshProjectFn ?? refreshProject)({
					repo: input.repos.projects,
					config: input.projectsConfig,
					id: project.id,
					...(input.ref !== undefined ? { ref: input.ref } : {}),
					spawn: input.projectSpawn,
					...(input.now !== undefined ? { now: input.now } : {}),
					...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
				})
			: null;
	const projectAfterRefresh = refreshed?.project ?? project;

	// warren-618b: fold per-project provider/model defaults onto the agent
	// frontmatter, with the operator's per-run override winning. Final order
	// is operator override > .warren/defaults.json > agent frontmatter. The
	// resolved values ride the same `withProviderOverrides` path, so the
	// frozen `runs.rendered_agent_json` reflects the effective frontmatter
	// regardless of which slot supplied it.
	const projectDefaults = await readProjectDefaults(
		input.warrenConfigs,
		projectAfterRefresh.id,
		projectAfterRefresh.localPath,
	);
	const effectiveProvider = resolveOverride(
		input.providerOverride,
		projectDefaults?.defaultProvider,
	);
	const effectiveModel = resolveOverride(input.modelOverride, projectDefaults?.defaultModel);
	const agent = withProviderOverrides(baseAgent, {
		...(effectiveProvider !== undefined ? { providerOverride: effectiveProvider } : {}),
		...(effectiveModel !== undefined ? { modelOverride: effectiveModel } : {}),
	});

	// Build the seed payload BEFORE creating the warren row so a malformed
	// expertise_seed / pi_skills / pi_prompts section surfaces as a clean
	// `RunSpawnError` with no half-spawned row to garbage-collect. Anything
	// burrow rejects later still rolls back via the try/catch below.
	const seedResult = buildSeedFiles(agent);

	// warren-39c3: resolve placement BEFORE creating the warren row so
	// `runs.worker_id` lands at row-creation time. `placeFor` reads the
	// `workers` table — affinity → least-loaded → alphabetical tiebreak
	// across `healthy` workers — and raises `NoEligibleWorkerError` if
	// nothing is placeable, which the caller surfaces as a structured
	// error.
	const placement = await input.burrowClientPool.placeFor({ projectId: projectAfterRefresh.id });

	const run = await input.repos.runs.create({
		agentName: agent.name,
		projectId: projectAfterRefresh.id,
		prompt: input.prompt,
		renderedAgentJson: agent,
		trigger: input.trigger ?? "manual",
		workerId: placement.workerName,
		...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
		...(input.plotId !== undefined && input.plotId !== "" ? { plotId: input.plotId } : {}),
		...(input.mode !== undefined ? { mode: input.mode } : {}),
		now: input.now?.(),
	});

	// warren-9993: compose the burrow workspace branch as `${prefix}/${run.id}`
	// so the branch traces back to the warren run on `git log` / PR review.
	// Precedence project default > env > "burrow" (the legacy default,
	// preserved for backward compatibility).
	const branch = composeRunBranch(
		resolveRunBranchPrefix({
			projectDefault: projectDefaults?.runBranchPrefix,
			envDefault: input.runBranchPrefixDefault,
		}),
		run.id,
	);

	// warren-e26f: when the run is bound to a Plot, inject the env vars the
	// `plot` CLI inside the sandbox needs to identify itself. Gated on
	// project.hasPlot (already validated above) AND a concrete plot_id on
	// the run row — both must be set, otherwise we leave env empty so a
	// non-Plot dispatch is byte-identical to the pre-change behavior. Actor
	// shape is `agent:<agent-name>:<run-id>` per warren-000b SPEC §6 / Plot
	// write-ACL contract. Run id is generated by runs.create above so it's
	// already in hand.
	const plotEnv = composePlotEnv(run.plotId, agent.name, run.id);

	let burrow: Burrow | null = null;
	try {
		burrow = await provisionBurrow(
			placement.client,
			projectAfterRefresh.localPath,
			projectAfterRefresh.gitUrl,
			burrowConfig.network,
			agent.name,
			seedResult.files,
			branch,
			plotEnv,
		);
		// warren-39c3: persist the burrow → worker mapping (sticky-by-burrow)
		// so cancel / steer / reap / fan-out reads can resolve the owning
		// worker via `pool.clientFor({burrowId})`. Created in the same turn as
		// `attachBurrow` so a crash between the two windows leaves the row
		// consistent: either both are missing or both are populated.
		await input.repos.burrows.create({
			id: burrow.id,
			workerId: placement.workerName,
			...(input.now !== undefined ? { now: input.now() } : {}),
		});
		await input.repos.runs.attachBurrow(run.id, { burrowId: burrow.id });

		// warren-ebca: dispatch onto the burrow runtime id, not the canopy
		// agent name. Built-in agents whose name happens to match a burrow
		// runtime (claude-code / sapling / pi) keep working via the
		// `agent.name` fallback in readRuntimeId; interactive agents like
		// brainstorm / planner declare `frontmatter.runtime` to compose
		// onto an existing runtime instead of demanding their own.
		const burrowRun = await dispatchRun(
			placement.client,
			burrow.id,
			readRuntimeId(agent),
			composeDispatchPrompt(agent.sections.system, input.prompt),
			composeBurrowMetadata(input.metadata, agent.frontmatter),
		);
		const updated = await input.repos.runs.attachBurrow(run.id, { burrowRunId: burrowRun.id });
		// pl-bb70 step 4: stamp the seed's warren-namespaced extensions after
		// dispatch lands. Fire-and-log — anything that throws here (sd not
		// on PATH, project clone vanished, write race) emits a system event
		// on the run and DOES NOT roll the dispatch back. Mirrors the cron
		// tick's clearScheduledFor recovery shape in src/triggers/tick.ts.
		if (input.seedId !== undefined && input.seedsCli !== undefined) {
			await writeSeedExtensions({
				repos: input.repos,
				seedsCli: input.seedsCli,
				projectPath: projectAfterRefresh.localPath,
				seedId: input.seedId,
				runId: run.id,
				agentName: agent.name,
				trigger: input.trigger,
				now: input.now?.() ?? new Date(),
			});
		}
		// warren-e848 / pl-2047 step 5: append a `run_dispatched` event to
		// the originating Plot. Fire-and-log — failures emit a
		// `plot_run_dispatched_failed` system event and DO NOT roll the
		// dispatch back. Mirrors the writeSeedExtensions posture above and
		// the cron tick's clearScheduledFor recovery shape.
		if (updated.plotId !== null && updated.plotId !== "") {
			await emitRunDispatchedToPlot({
				repos: input.repos,
				runId: run.id,
				plotDir: join(projectAfterRefresh.localPath, ".plot"),
				plotId: updated.plotId,
				handle: resolveDispatcherHandle(input.dispatcherHandle),
				agentName: agent.name,
				model: extractModel(agent.frontmatter),
				projectId: projectAfterRefresh.id,
				appender: input.plotAppender ?? defaultPlotAppender,
				now: input.now?.() ?? new Date(),
			});
		}
		return { run: updated, burrow, burrowRun, agent };
	} catch (err) {
		await rollback(input, run.id, burrow, placement.client);
		throw err;
	}
}

interface WriteSeedExtensionsInput {
	readonly repos: Repos;
	readonly seedsCli: SeedsCliDeps;
	readonly projectPath: string;
	readonly seedId: string;
	readonly runId: string;
	readonly agentName: string;
	readonly trigger?: string;
	readonly now: Date;
}

/**
 * Merge warren-namespaced keys (`role`, `trigger`, `lastRunId`, `lastRunAt`)
 * onto a seed's `extensions` after the run is dispatched. Trigger strings
 * that don't match `WarrenTriggerKind` (e.g. the legacy `manual-trigger`
 * used by `POST /projects/:id/triggers/:triggerId/run`) are dropped from
 * the payload rather than rejected — the strict schema would otherwise
 * fail the whole merge and lose `role` / `lastRunId` / `lastRunAt` too.
 *
 * Failures are surfaced as a `seeds_extension_write_failed` system event
 * on the run and swallowed: the dispatch already succeeded, and rolling
 * back here would be worse than a stale seed extension that the operator
 * can fix manually (or that step 7's acceptance scenario detects).
 */
async function writeSeedExtensions(input: WriteSeedExtensionsInput): Promise<void> {
	const triggerParse = WarrenTriggerKind.safeParse(input.trigger ?? "manual");
	const payload: WarrenExtensions = {
		role: input.agentName,
		lastRunId: input.runId,
		lastRunAt: input.now.toISOString(),
		...(triggerParse.success ? { trigger: triggerParse.data } : {}),
	};
	try {
		await updateExtensions(input.seedsCli, input.projectPath, input.seedId, payload);
	} catch (err) {
		await recordExtensionWriteFailure(input.repos, input.runId, input.seedId, formatError(err));
	}
}

async function recordExtensionWriteFailure(
	repos: Repos,
	runId: string,
	seedId: string,
	reason: string,
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: new Date().toISOString(),
			kind: "seeds_extension_write_failed",
			stream: "system",
			payload: { seedId, reason },
		});
	} catch {
		// Event write failed too — db handle is gone or the run row was
		// finalized in a race. Nothing left to surface; rolling back the
		// dispatch over a logging failure is unambiguously worse.
	}
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

interface EmitRunDispatchedToPlotInput {
	readonly repos: Repos;
	readonly runId: string;
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	readonly agentName: string;
	readonly model: string | null;
	readonly projectId: string;
	readonly appender: SpawnPlotAppender;
	readonly now: Date;
}

/**
 * Append a `run_dispatched` event to the originating Plot's event log
 * (warren-e848). The seed acceptance requires the event to be present
 * "within one tick of a successful spawn"; the spawn already succeeded
 * by the time we get here, so failure is logged as
 * `plot_run_dispatched_failed` and swallowed — see the rationale on
 * `writeSeedExtensions` and pl-2f15 risk #4 for the same posture on the
 * seeds extension write.
 */
async function emitRunDispatchedToPlot(input: EmitRunDispatchedToPlotInput): Promise<void> {
	try {
		await input.appender.appendRunDispatched({
			plotDir: input.plotDir,
			plotId: input.plotId,
			handle: input.handle,
			runId: input.runId,
			agentName: input.agentName,
			model: input.model,
			projectId: input.projectId,
		});
	} catch (err) {
		await recordPlotAppendFailure(
			input.repos,
			input.runId,
			input.plotId,
			formatError(err),
			input.now,
		);
	}
}

async function recordPlotAppendFailure(
	repos: Repos,
	runId: string,
	plotId: string,
	reason: string,
	now: Date,
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind: "plot_run_dispatched_failed",
			stream: "system",
			payload: { plotId, reason },
		});
	} catch {
		// Event write failed too — the db handle is gone or the run row was
		// finalized in a race. Same fall-through shape as
		// recordExtensionWriteFailure above.
	}
}

/**
 * Validate a caller-supplied dispatcher handle against Plot's actor segment
 * regex; downgrade malformed / empty input to `DEFAULT_DISPATCHER_HANDLE`
 * so the Plot append's `user:<handle>` actor is always well-formed.
 * Exported so the PlanRun handler (warren-b89f / pl-7937 step 4) can apply
 * the same sanitization before emitting `plan_run_dispatched`.
 */
export function resolveDispatcherHandle(input: string | undefined): string {
	const trimmed = (input ?? "").trim();
	if (trimmed === "") return DEFAULT_DISPATCHER_HANDLE;
	if (!ACTOR_SEGMENT_RE.test(trimmed)) return DEFAULT_DISPATCHER_HANDLE;
	return trimmed;
}

function extractModel(frontmatter: Record<string, unknown>): string | null {
	const model = frontmatter.model;
	if (typeof model === "string" && model.length > 0) return model;
	return null;
}

/**
 * Default `SpawnPlotAppender`: opens a `UserPlotClient` against the
 * project's `.plot/` directory, appends the `run_dispatched` event, and
 * closes the SQLite index handle. On a first-attempt failure (the
 * documented seed case is a missing `.plot/.index.db` on the project's
 * first ever dispatch), `rebuildIndex` is invoked best-effort and the
 * append is retried once before the error propagates to
 * `recordPlotAppendFailure`.
 */
const defaultPlotAppender: SpawnPlotAppender = {
	async appendRunDispatched(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			const plot = client.get(input.plotId);
			const data = {
				run_id: input.runId,
				agent: input.agentName,
				model: input.model,
				project: input.projectId,
			};
			try {
				await plot.append({ type: "run_dispatched", data });
			} catch (err) {
				try {
					await client.rebuildIndex();
				} catch {
					// Rebuild is a best-effort recovery; if it fails we still
					// try the append once more so the original error wins.
				}
				try {
					await plot.append({ type: "run_dispatched", data });
				} catch {
					throw err;
				}
			}
		} finally {
			client.close();
		}
	},
};

async function provisionBurrow(
	client: BurrowClient,
	projectRoot: string,
	originUrl: string,
	network: NetworkPolicy | undefined,
	agentId: string,
	seedFiles: readonly HttpWorkspaceFile[],
	branch: string,
	env: Record<string, string> | null,
): Promise<Burrow> {
	// Warren's canopy agent name is the burrow runtime id by convention
	// (claude-code → claude-code). Forwarding it as a `[[agents]]` patch row
	// at up-time lets burrow mount the runtime's binary into the sandbox
	// even when the project clone has no burrow.toml — without this,
	// collectToolchainPaths returns [] and bwrap fails `execvp claude`
	// (warren-8526 / burrow-55e3).
	//
	// The seed payload (R-07) rides on the same up call so provisioning +
	// `.canopy/`/`.mulch/`/`.seeds/`/`.pi/` drops are atomic: a failed seed
	// rolls the burrow back on burrow's side before this promise resolves,
	// so the caller never observes a half-seeded workspace.
	//
	// `branch` is composed by spawnRun (warren-9993) as `${prefix}/${run.id}`
	// so the burrow workspace branch traces back to the warren run row even
	// when the burrow id is stripped from logs. Burrow accepts `branch` on
	// `POST /burrows`; passing it always (rather than letting burrow default
	// to `burrow/<bur-id>`) keeps the suffix on the warren id no matter what.
	return withTransportMapping(client.config, () =>
		client.burrowsUp({
			projectRoot,
			originUrl,
			agents: [agentId],
			branch,
			...(network !== undefined ? { network } : {}),
			...(seedFiles.length > 0 ? { seed: { files: seedFiles } } : {}),
			...(env !== null ? { env } : {}),
		}),
	);
}

/**
 * Build the per-run env block forwarded onto the burrow `up` call when the
 * run is bound to a Plot (warren-e26f). Returns `null` when no `plotId`
 * is set so non-Plot dispatches send the same body they did before this
 * change — the spawn flow's existing tests bracket that invariant.
 */
function composePlotEnv(
	plotId: string | null,
	agentName: string,
	runId: string,
): Record<string, string> | null {
	if (plotId === null) return null;
	return {
		PLOT_ID: plotId,
		PLOT_ACTOR: `agent:${agentName}:${runId}`,
	};
}

async function dispatchRun(
	client: BurrowClient,
	burrowId: string,
	agentId: string,
	prompt: string,
	metadata: unknown,
): Promise<BurrowRun> {
	return withTransportMapping(client.config, () =>
		client.http.runs.create({
			burrowId,
			agentId,
			prompt,
			...(metadata !== undefined ? { metadata } : {}),
		}),
	);
}

/**
 * Prefix the user's run prompt with the agent's `system` section so the
 * canopy-defined operating contract (workspace map, rituals, expectations)
 * actually reaches claude. Burrow's claude-code runtime feeds the dispatch
 * prompt to the agent as a single user turn — it never reads
 * `.canopy/agent.json` itself, so without this prepend the canopy `system`
 * body is dead text on disk.
 *
 * `runs.prompt` (warren-side) keeps the user-typed input verbatim; only
 * the body sent on POST /burrows/:id/runs is composed.
 */
export function composeDispatchPrompt(systemBody: string | undefined, userPrompt: string): string {
	const trimmed = (systemBody ?? "").trim();
	if (trimmed === "") return userPrompt;
	return `${trimmed}\n\n---\n\n${userPrompt}`;
}

async function rollback(
	input: SpawnRunInput,
	runId: string,
	burrow: Burrow | null,
	client: BurrowClient,
): Promise<void> {
	try {
		await input.repos.runs.finalize(runId, "cancelled", input.now?.());
	} catch {
		// Either the row was already terminal (shouldn't happen on this path)
		// or the db handle is gone — either way, nothing to recover here.
	}
	if (burrow !== null) {
		try {
			await withTransportMapping(client.config, () =>
				client.http.burrows.destroy(burrow.id, { archive: false }),
			);
		} catch {
			// Best-effort cleanup. The operator can list stranded burrows via
			// burrow's own UI / CLI; we don't want a cleanup failure to mask
			// the original error the caller is about to see rethrown.
		}
	}
}

/**
 * Re-validate the cached row's renderedJson before use. Refresh.ts stores
 * a parsed `AgentDefinition` directly, so the column shape is normally
 * exactly that — but the column type is `unknown`, and a corrupted row
 * shouldn't crash the spawn flow with a TypeError. If the cache holds the
 * raw `cn render` envelope (older registry refresh path), fall back to
 * parsing it.
 */
function readCachedAgent(raw: unknown, name: string): AgentDefinition {
	if (typeof raw !== "object" || raw === null) {
		throw new RunSpawnError(`cached agent "${name}" has malformed renderedJson`);
	}
	const candidate = raw as Record<string, unknown>;
	if (
		typeof candidate.name === "string" &&
		typeof candidate.version === "number" &&
		typeof candidate.sections === "object" &&
		candidate.sections !== null &&
		!Array.isArray(candidate.sections)
	) {
		const sections = candidate.sections as Record<string, unknown>;
		for (const [key, value] of Object.entries(sections)) {
			if (typeof value !== "string") {
				throw new RunSpawnError(`cached agent "${name}" has non-string section "${key}"`);
			}
		}
		return {
			name: candidate.name,
			version: candidate.version,
			sections: sections as Record<string, string>,
			resolvedFrom: Array.isArray(candidate.resolvedFrom)
				? candidate.resolvedFrom.filter((s): s is string => typeof s === "string")
				: [],
			frontmatter:
				typeof candidate.frontmatter === "object" &&
				candidate.frontmatter !== null &&
				!Array.isArray(candidate.frontmatter)
					? (candidate.frontmatter as Record<string, unknown>)
					: {},
		};
	}
	if (RenderResponseSchema.safeParse(raw).success) {
		return parseRenderedAgent(raw, name);
	}
	throw new RunSpawnError(`cached agent "${name}" does not match AgentDefinition shape`);
}

/**
 * Merge the operator-supplied dispatch metadata with the post-override agent
 * frontmatter so burrow's piRuntime can read provider/model from
 * `Run.metadataJson.frontmatter` (burrow-b5b4). Without this, ctx.frontmatter
 * is undefined inside burrow and buildPiArgv falls back to PI_DEFAULT_MODEL
 * even when warren resolved a non-default per warren-618b / warren-f8c0.
 *
 * Operator metadata wins on key collisions except for `frontmatter`, which is
 * always sourced from the agent — it's the resolved envelope, not a
 * caller-supplied field.
 */
function composeBurrowMetadata(
	operatorMetadata: unknown,
	frontmatter: Record<string, unknown>,
): Record<string, unknown> {
	const base =
		typeof operatorMetadata === "object" && operatorMetadata !== null
			? (operatorMetadata as Record<string, unknown>)
			: {};
	return { ...base, frontmatter };
}

/**
 * Pick the effective frontmatter override given a per-run operator value and
 * a project default. Empty / whitespace-only strings are treated the same as
 * "not provided" (matches `withProviderOverrides`'s shape). Returns the
 * operator value when present, otherwise the project default, otherwise
 * `undefined` so the agent's own frontmatter remains in force.
 */
function resolveOverride(
	operator: string | undefined,
	projectDefault: string | undefined,
): string | undefined {
	const op = operator?.trim();
	if (op !== undefined && op !== "") return op;
	const pd = projectDefault?.trim();
	if (pd !== undefined && pd !== "") return pd;
	return undefined;
}

/**
 * Load the project's `.warren/defaults.json` envelope through the cache.
 * Returns `null` when no cache is wired (CLI/tests that don't care about
 * project defaults) or when the load fails — a malformed `.warren/` should
 * never abort a spawn, just downgrade to "no project default" behavior.
 */
async function readProjectDefaults(
	cache: WarrenConfigCache | undefined,
	projectId: string,
	projectPath: string,
): Promise<DefaultsConfig | null> {
	if (cache === undefined) return null;
	try {
		const envelope = await cache.get(projectId, projectPath);
		return envelope.defaults;
	} catch {
		// Project clone vanished or .warren/ I/O errored — leave the agent
		// frontmatter as the final source of truth and let the rest of the
		// flow surface any project-state failure on its own path.
		return null;
	}
}

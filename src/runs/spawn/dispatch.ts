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
 *      `.seeds/`, `.pi/` workspace drops (see `../seed.ts`) ride along as
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
 * burrow → worker pinning is written in the same turn as `attachBurrow`
 * (sticky-by-burrow for cancel / steer / reap / fan-out reads).
 *
 * The warren run row is created BEFORE any burrow call, with both
 * burrow IDs nulled — `attachBurrow` writes them back as each call
 * succeeds, so the warren `run_xxx` id is in hand throughout the flow.
 *
 * Failure handling: anything before step 2 just throws (no warren row
 * exists). Failures from step 2 onward are caught — the warren row is
 * transitioned `queued → cancelled` and any provisioned burrow is
 * best-effort destroyed; a seed-validation failure inside `burrows.up`
 * rolls back on burrow's side before warren observes a burrow id. The
 * original error is rethrown for the caller (HTTP route, CLI).
 */

import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { refreshProject } from "../../projects/manage.ts";
import {
	readRuntimeId,
	withMaxCostUsdOverride,
	withProviderOverrides,
} from "../../registry/schema.ts";
import type { RunSpec, RuntimeProvider } from "../../runtime/contract.ts";
import { LocalProvider } from "../../runtime/local/provider.ts";
import { interactiveRuntimeOverride } from "../../warren-config/schema.ts";
import { composeRunBranch, resolveRunBranchPrefix } from "../branch.ts";
import { parseBurrowConfig } from "../burrow-config.ts";
import { buildSeedFiles } from "../seed.ts";
import { readCachedAgent, readProjectDefaults, resolveOverride } from "./agent-cache.ts";
import { injectWarrenCallbackEnv } from "./callback-env.ts";
import {
	defaultPlotAppender,
	emitRunDispatchedToPlot,
	extractModel,
	resolveDispatcherHandle,
} from "./plot-append.ts";
import {
	bindRunLogger,
	logDispatched,
	logPlacement,
	logProvisioned,
	logSpawnFailed,
	rollback,
} from "./rollback.ts";
import { writeSeedExtensions } from "./seed-extensions.ts";
import type { SpawnRunInput, SpawnRunResult } from "./types.ts";
import { resolveCoordinationProject } from "./util.ts";

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

	// warren-4b11: continuation runs ("re-run with follow-up") seed their
	// workspace from the prior run's pushed branch instead of the project
	// default branch. Resolve the parent's branch up front and feed it as the
	// refresh ref so the local clone is checked out to the parent branch tip
	// before burrow forks the new run branch off it. The parent link is also
	// recorded on the new run row below so the UI can render a chain indicator
	// and chain cost/token totals are derivable by walking the link.
	const baseRef = await resolveContinuationRef(input, project);

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
					...(baseRef !== undefined ? { ref: baseRef } : {}),
					spawn: input.projectSpawn,
					...(input.now !== undefined ? { now: input.now } : {}),
					...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
				})
			: null;
	const projectAfterRefresh = refreshed?.project ?? project;

	// warren-c1a4: coordination project — host clone the post-dispatch
	// seed stamp + Plot append target (defaults to the execution project).
	const coordinationProject = await resolveCoordinationProject(
		input.repos,
		input.seedProjectId,
		projectAfterRefresh,
	);

	// warren-618b: fold per-project provider/model defaults onto the agent
	// frontmatter, operator per-run override winning. Order: operator
	// override > .warren/defaults.json > agent frontmatter, all riding the
	// same `withProviderOverrides` path onto frozen `rendered_agent_json`.
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
	// warren-a63d: fold the per-trigger spend cap on top (trigger > agent).
	const agent = withMaxCostUsdOverride(
		withProviderOverrides(baseAgent, {
			...(effectiveProvider !== undefined ? { providerOverride: effectiveProvider } : {}),
			...(effectiveModel !== undefined ? { modelOverride: effectiveModel } : {}),
		}),
		input.maxCostUsdOverride,
	);

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
	logPlacement(input.logger, placement.workerName, projectAfterRefresh.id);

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
		...(input.parentRunId !== undefined && input.parentRunId !== ""
			? { parentRunId: input.parentRunId, cloneKind: input.cloneKind ?? "continue" }
			: {}),
		...(input.targetBranch?.trim() ? { targetBranch: input.targetBranch } : {}),
		now: input.now?.(),
	});

	// warren-9993/a993: burrow branch = `${prefix}/${run.id}` (prefix precedence
	// project default > env > "burrow"); a CI-fixer run's `targetBranch` pins it
	// to the open PR head ref instead, so the fixer's commits re-run that PR's CI.
	const branch = composeRunBranch(
		resolveRunBranchPrefix({
			projectDefault: projectDefaults?.runBranchPrefix,
			envDefault: input.runBranchPrefixDefault,
		}),
		run.id,
		input.targetBranch,
	);

	// warren-e26f: when the run is bound to a Plot, inject the env vars the
	// `plot` CLI inside the sandbox needs to identify itself. Gated on
	// project.hasPlot (already validated above) AND a concrete plot_id on
	// the run row — both must be set, otherwise we leave env empty so a
	// non-Plot dispatch is byte-identical to the pre-change behavior. Actor
	// shape is `agent:<agent-name>:<run-id>` per warren-000b SPEC §6 / Plot
	// write-ACL contract. Run id is generated by runs.create above so it's
	// already in hand.
	const runEnv = composeRunEnv(
		run.plotId,
		agent.name,
		run.id,
		projectDefaults?.qualityGate,
		input.serverEnv,
	);

	// warren-b802: resolve per-project runtime override for the planner
	// interactive agent at dispatch time so the agent row
	// stays honest as 'builtin'.
	const runtimeOverride = interactiveRuntimeOverride(agent.name, projectDefaults);

	const log = bindRunLogger(input.logger, run.id);
	// Runtime-provider seam (K8s migration pl-829f step 13 / warren-1f56).
	// `provider.create` collapses burrow's provision + dispatch (`burrowsUp` +
	// `runs.create`) into one call and owns the burrow-half rollback on a partial
	// failure (best-effort archive:false destroy + rethrow). Default to the
	// burrow-backed LocalProvider over the injected pool + serverEnv so callers
	// that only wire `burrowClientPool` keep working (same fallback shape as
	// `reapRun`). Placement (`placeFor`) stays domain — it resolves the worker
	// NAME persisted onto `runs.worker_id` / `burrows.worker_id` for the still
	// sticky-by-burrow reap / bridge reads; the provider resolves its own client.
	const provider: RuntimeProvider =
		input.runtimeProvider ??
		new LocalProvider({
			burrowClientPool: () => input.burrowClientPool,
			...(input.serverEnv !== undefined ? { serverEnv: input.serverEnv } : {}),
		});
	const runtimeId = readRuntimeId(agent, runtimeOverride);
	// Neutral RunSpec (provider maps it to the two burrow calls). `network` is
	// REQUIRED on the seam, so resolve burrow's own default (`none`) here — the
	// domain now owns the "no explicit network ⇒ default" decision that
	// `provisionBurrow` used to defer to burrow by omitting the key. `baseBranch`
	// is carried for the seam contract (K8s init container needs it); the
	// LocalProvider IGNORES it, byte-faithful to today's dispatch which never
	// sent it. `hostClonePathHint` is ALWAYS the host clone projectRoot.
	const spec: RunSpec = {
		runId: run.id,
		originUrl: projectAfterRefresh.gitUrl,
		branch,
		baseBranch: projectAfterRefresh.defaultBranch,
		hostClonePathHint: projectAfterRefresh.localPath,
		runtimeId,
		prompt: composeDispatchPrompt(agent.sections.system, input.prompt),
		metadata: composeBurrowMetadata(input.metadata, agent.frontmatter),
		mode: input.mode ?? "batch",
		network: burrowConfig.network ?? "none",
		seedFiles: seedResult.files,
		env: runEnv,
	};
	try {
		const dispatchStart = Date.now();
		const handle = await provider.create(spec);
		logProvisioned(log, handle.sandboxId, placement.workerName, dispatchStart);
		// warren-39c3: persist the burrow → worker mapping (sticky-by-burrow)
		// so cancel / steer / reap reads resolve the owning worker via
		// `pool.clientFor({burrowId})`. The provider owns partial-failure cleanup,
		// so these warren rows are written only after `create` fully succeeds —
		// a dispatch that fails mid-flight leaves no burrow row and no burrow_id
		// on the run (the provider already destroyed the burrow).
		await input.repos.burrows.create({
			id: handle.sandboxId,
			workerId: placement.workerName,
			...(input.now !== undefined ? { now: input.now() } : {}),
		});
		await input.repos.runs.attachBurrow(run.id, { burrowId: handle.sandboxId });
		const updated = await input.repos.runs.attachBurrow(run.id, {
			burrowRunId: handle.providerRunId,
		});
		logDispatched(log, handle.sandboxId, handle.providerRunId, dispatchStart);
		// pl-bb70 step 4: stamp the seed's warren-namespaced extensions after
		// dispatch lands. Fire-and-log — anything that throws here (sd not
		// on PATH, project clone vanished, write race) emits a system event
		// on the run and DOES NOT roll the dispatch back. Mirrors the cron
		// tick's clearScheduledFor recovery shape in src/triggers/tick.ts.
		if (input.seedId !== undefined && input.seedsCli !== undefined) {
			await writeSeedExtensions({
				repos: input.repos,
				seedsCli: input.seedsCli,
				projectPath: coordinationProject.localPath,
				seedId: input.seedId,
				runId: run.id,
				agentName: agent.name,
				trigger: input.trigger,
				now: input.now?.() ?? new Date(),
			});
		}
		// warren-e848 / pl-2047 step 5: append a `run_dispatched` event to the
		// originating Plot. Fire-and-log — same posture as writeSeedExtensions.
		if (updated.plotId !== null && updated.plotId !== "") {
			await emitRunDispatchedToPlot({
				repos: input.repos,
				runId: run.id,
				plotDir: join(coordinationProject.localPath, ".plot"),
				plotId: updated.plotId,
				handle: resolveDispatcherHandle(input.dispatcherHandle),
				agentName: agent.name,
				model: extractModel(agent.frontmatter),
				projectId: coordinationProject.id,
				...(input.executionRepo !== undefined ? { executionRepo: input.executionRepo } : {}),
				appender: input.plotAppender ?? defaultPlotAppender,
				now: input.now?.() ?? new Date(),
			});
		}
		// `workspacePath` is a burrow host path with no provider-neutral home, so
		// the seam's `RunHandle` drops it (design §: the domain must never leak a
		// host path). It survives as a display-only field on the HTTP response +
		// UI, slated for removal with the multi-worker/`/burrows` surface (plan
		// §5.C); no value is available across the seam, so it is empty here.
		return {
			run: updated,
			burrow: { id: handle.sandboxId, workspacePath: "" },
			burrowRun: { id: handle.providerRunId },
			agent,
		};
	} catch (err) {
		logSpawnFailed(log, null, err);
		// The provider already destroyed any provisioned burrow on a partial
		// failure (its create() owns the burrow-half rollback), so the domain
		// rollback only unwinds the warren row (`persistSpawnFailure`): pass
		// `burrow: null` so it does not attempt a second destroy.
		await rollback(input, run.id, null, placement.client, log, err);
		throw err;
	}
}

/**
 * Resolve the git ref the project clone should be refreshed to before the
 * burrow forks the new run branch (warren-4b11).
 *
 * - No `parentRunId` → explicit `ref`, else the `targetBranch` push target
 *   (warren-709e), else undefined → refreshProject's project default branch.
 * - `parentRunId` set with `cloneKind: "replicate"` (warren-e96f) → the
 *   caller's explicit `ref` (or the project default branch). A replicate is a
 *   fresh re-dispatch of the parent's config, NOT a continuation, so it must
 *   NOT check out the parent's pushed branch — that branch may be stale or may
 *   never have been pushed (parent failed early).
 * - `parentRunId` set (default `cloneKind: "continue"`) → the parent run's
 *   pushed branch, recomposed from the
 *   same prefix precedence the parent's spawn used
 *   (`composeRunBranch(resolveRunBranchPrefix(...), parentRunId)`). We read
 *   the project defaults here (a lightweight pre-refresh peek) only to get
 *   the prefix; the working tree's `.warren/` is stable across a project's
 *   runs, so this matches the branch the parent actually pushed.
 *
 * The parent must belong to the same project — a continuation forks the
 * parent's branch on the same origin, so a cross-project parent would be a
 * meaningless base. We reject it with a typed ValidationError rather than
 * silently checking out a branch that doesn't exist on this origin.
 */
async function resolveContinuationRef(
	input: SpawnRunInput,
	project: { id: string; localPath: string },
): Promise<string | undefined> {
	if (!input.parentRunId) return input.ref ?? input.targetBranch; // warren-709e
	// Replicate (warren-e96f): fresh re-dispatch against the explicit ref /
	// project default base, not the parent's pushed branch. We still validate
	// the parent below (same-project guard), but the base ref is the caller's.
	if (input.cloneKind === "replicate") {
		const parent = await input.repos.runs.require(input.parentRunId);
		if (parent.projectId !== project.id) {
			throw new ValidationError(
				`parent run ${parent.id} belongs to a different project; a re-run must reuse the same project`,
				{ recoveryHint: "re-run with a cloneFromRunId from the same project, or omit it" },
			);
		}
		return input.ref;
	}
	const parent = await input.repos.runs.require(input.parentRunId);
	if (parent.projectId !== project.id) {
		throw new ValidationError(
			`parent run ${parent.id} belongs to a different project; a continuation must reuse the same project's branch`,
			{ recoveryHint: "re-run with a parentRunId from the same project, or omit it" },
		);
	}
	const defaults = await readProjectDefaults(input.warrenConfigs, project.id, project.localPath);
	const prefix = resolveRunBranchPrefix({
		projectDefault: defaults?.runBranchPrefix,
		envDefault: input.runBranchPrefixDefault,
	});
	return composeRunBranch(prefix, parent.id);
}

// warren-b893: route Bun cache outside the workspace so `git add .` never sweeps it.
const BUN_INSTALL_CACHE_DIR = "/tmp/bun-install-cache";
/** Merge Plot env vars (warren-e26f), quality-gate (warren-5797), and Bun cache relocation
 * (warren-b893) into the sandbox env. Always returns a non-empty object. */
function composeRunEnv(
	plotId: string | null,
	agentName: string,
	runId: string,
	qualityGate: string | undefined,
	serverEnv?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const env: Record<string, string> = { BUN_INSTALL_CACHE_DIR };
	if (plotId !== null) {
		env.PLOT_ID = plotId;
		env.PLOT_ACTOR = `agent:${agentName}:${runId}`;
	}
	if (qualityGate !== undefined) env.WARREN_QUALITY_GATE = qualityGate;
	// warren-f248: forward the warren API token + loopback URL so the agent
	// can call back into warren's HTTP API (audit-warden delivery path).
	injectWarrenCallbackEnv(env, serverEnv ?? process.env);
	return env;
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

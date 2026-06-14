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
import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { refreshProject } from "../../projects/manage.ts";
import { readRuntimeId, withProviderOverrides } from "../../registry/schema.ts";
import { interactiveRuntimeOverride } from "../../warren-config/schema.ts";
import { composeRunBranch, resolveRunBranchPrefix } from "../branch.ts";
import { parseBurrowConfig } from "../burrow-config.ts";
import { buildSeedFiles } from "../seed.ts";
import { readCachedAgent, readProjectDefaults, resolveOverride } from "./agent-cache.ts";
import {
	defaultPlotAppender,
	emitRunDispatchedToPlot,
	extractModel,
	resolveDispatcherHandle,
} from "./plot-append.ts";
import { writeSeedExtensions } from "./seed-extensions.ts";
import type { SpawnRunInput, SpawnRunResult } from "./types.ts";

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
		...(input.parentRunId !== undefined && input.parentRunId !== ""
			? { parentRunId: input.parentRunId, cloneKind: input.cloneKind ?? "continue" }
			: {}),
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
	const runEnv = composeRunEnv(run.plotId, agent.name, run.id, projectDefaults?.qualityGate);

	// warren-b802: resolve per-project runtime override for interactive
	// agents (brainstorm / planner) at dispatch time so the agent row
	// stays honest as 'builtin'.
	const runtimeOverride = interactiveRuntimeOverride(agent.name, projectDefaults);

	let burrow: Burrow | null = null;
	try {
		burrow = await provisionBurrow(
			placement.client,
			projectAfterRefresh.localPath,
			projectAfterRefresh.gitUrl,
			burrowConfig.network,
			readRuntimeId(agent, runtimeOverride),
			seedResult.files,
			branch,
			runEnv,
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

		// warren-ebca / warren-16f8: dispatch onto the burrow runtime id,
		// not the canopy agent name. Built-in agents that want a non-pi
		// runtime (claude-code / sapling) declare `frontmatter.runtime`
		// explicitly; everything else falls back to the pi default in
		// readRuntimeId. Interactive agents like brainstorm / planner also
		// declare `frontmatter.runtime` to compose onto an existing runtime.
		const burrowRun = await dispatchRun(
			placement.client,
			burrow.id,
			readRuntimeId(agent, runtimeOverride),
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

/**
 * Resolve the git ref the project clone should be refreshed to before the
 * burrow forks the new run branch (warren-4b11).
 *
 * - No `parentRunId` → the caller's explicit `ref` (or undefined, which
 *   refreshProject resolves to the project's tracked default branch).
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
	if (input.parentRunId === undefined || input.parentRunId === "") return input.ref;
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

async function provisionBurrow(
	client: BurrowClient,
	projectRoot: string,
	originUrl: string,
	network: NetworkPolicy | undefined,
	agentId: string,
	seedFiles: readonly HttpWorkspaceFile[],
	branch: string,
	env: Record<string, string>,
): Promise<Burrow> {
	// Caller forwards the burrow *runtime id* (`readRuntimeId(agent)`), not
	// the canopy agent name. Burrow's `up` resolves toolchain mounts by
	// looking each id up in its runtime registry (claude-code / sapling /
	// pi / codex). Interactive built-ins like brainstorm and planner compose
	// onto a runtime via `frontmatter.runtime` — passing their canopy
	// name here would mean burrow's registry.get returns nothing,
	// collectToolchainPaths returns [], and bwrap fails `execvp claude`
	// at run start (warren-8526 / burrow-55e3, regression warren-53e6).
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
			env,
		}),
	);
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
): Record<string, string> {
	const env: Record<string, string> = {
		BUN_INSTALL_CACHE_DIR,
	};
	if (plotId !== null) {
		env.PLOT_ID = plotId;
		env.PLOT_ACTOR = `agent:${agentName}:${runId}`;
	}
	if (qualityGate !== undefined) env.WARREN_QUALITY_GATE = qualityGate;
	return env;
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

/**
 * `spawnRun` — the composition flow (docs/design/agent-composition.md).
 *
 * One call drives the ritual that turns "the operator picked an agent +
 * project + prompt" into "the runtime has a dispatched run":
 *
 *   1. Resolve the cached agent definition (registry refresh seeded it
 *      via `cn render`). The rendered envelope is what gets frozen onto
 *      `runs.rendered_agent_json` — re-rendering at run time is
 *      deliberately not done here. Operators trigger a fresh render via
 *      `POST /agents/refresh` if they want one.
 *
 *   2. Build the neutral `RunSpec` (workspace inputs from the project clone,
 *      `network` from the agent's `burrow_config`, the `.canopy/.mulch/
 *      .seeds/.pi` workspace drops from `../seed.ts` as `seedFiles`, plus the
 *      composed env + prompt) and dispatch through the runtime seam,
 *      `provider.create(spec)` (warren-c42c). The provider — `LocalProvider`
 *      (burrow) or `K8sProvider` (pod) — materializes the workspace, seeds it,
 *      and starts the run, collapsing what used to be burrow's two-call
 *      provision-then-dispatch into one, and owns destroying any partially
 *      provisioned sandbox on a mid-flight failure.
 *
 * The warren run row is created BEFORE `provider.create`, with both
 * correlation ids nulled — `attachBurrow` writes back the handle's
 * `sandboxId` / `providerRunId` only after `create` fully succeeds, so the
 * warren `run_xxx` id is in hand throughout the flow while a failed dispatch
 * leaves no sandbox id on the row (the provider already tore it down). These
 * ids are the LocalProvider resume correlation the bridge reconnect path
 * reads after a host restart.
 *
 * Failure handling: anything before the `create` call just throws (no warren
 * row exists yet, or the row unwinds via the domain rollback). Failures from
 * `create` onward are caught — `rollback` finalizes the warren row
 * `failed`/`never_started` (the sandbox half is the provider's job). The
 * original error is rethrown for the caller (HTTP route, CLI).
 */

import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { refreshProject } from "../../projects/manage.ts";
import {
	readRuntimeId,
	withMaxCostUsdOverride,
	withProviderOverrides,
} from "../../registry/schema.ts";
import type { RunSpec, RuntimeProvider } from "../../runtime/contract.ts";
import { interactiveRuntimeOverride } from "../../warren-config/schema.ts";
import { composeRunBranch, resolveRunBranchPrefix } from "../branch.ts";
import { parseBurrowConfig } from "../burrow-config.ts";
import { resolveCapOverride } from "../cost-cap.ts";
import { lifecycleBus } from "../lifecycle-bus.ts";
import { buildSeedFiles } from "../seed.ts";
import { validateTargetBranch } from "../target-branch.ts";
import { readCachedAgent, readProjectDefaults, resolveOverride } from "./agent-cache.ts";
import { type EnvLike, injectWarrenCallbackEnv } from "./callback-env.ts";
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

/**
 * Vestigial worker-placement label carried on the `spawn.placement` /
 * `spawn.provisioned` log lines (warren-c42c). Multi-worker placement was
 * retired with the K8s migration (warren-76c5 / warren-3743) — a run has no
 * "worker" on either backend — so this is a fixed log field, not a routing
 * decision. Kept a local neutral constant now that the spawn path no longer
 * imports burrow-client's `LOCAL_WORKER_NAME`.
 */
const WORKER_PLACEMENT_LABEL = "local";

export async function spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
	if (input.prompt.trim() === "") {
		throw new ValidationError("prompt cannot be empty");
	}

	const agentRow = await input.repos.agents.get(input.agentName);
	if (!agentRow) {
		throw new NotFoundError(`agent not found: ${input.agentName}`);
	}
	const project = await input.repos.projects.require(input.projectId);
	// warren-3a75: `targetBranch` is a push target the finalize step writes to
	// directly, with no PR and therefore no Article IX gate. Enforce the ref
	// grammar and refuse the project default branch BEFORE any side effect (no
	// clone refresh, no run row). Repair runs targeting an existing PR head
	// branch are unaffected.
	const targetBranch = validateTargetBranch(input.targetBranch, project.defaultBranch);

	const baseAgent = readCachedAgent(agentRow.renderedJson, agentRow.name);
	const burrowConfig = parseBurrowConfig(baseAgent.sections.burrow_config);

	// warren-4b11: continuation runs ("re-run with follow-up") seed their
	// workspace from the prior run's pushed branch instead of the project
	// default branch. Resolve the parent's branch up front and feed it as the
	// refresh ref so the local clone is checked out to the parent branch tip
	// before burrow forks the new run branch off it. The parent link is also
	// recorded on the new run row below so the UI can render a chain indicator
	// and chain cost/token totals are derivable by walking the link.
	const baseRef = await resolveContinuationRef(input, project, targetBranch);

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
					token: input.githubToken,
					spawn: input.projectSpawn,
					...(input.now !== undefined ? { now: input.now } : {}),
					...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
				})
			: null;
	const projectAfterRefresh = refreshed?.project ?? project;

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
	// warren-a63d: fold the per-dispatch spend cap on top. The full chain
	// (override > agent frontmatter > project default, with malformed agent
	// values still failing open) lives in resolveCapOverride — cost-cap.ts
	// owns the semantics, this site only feeds it the three sources.
	const capOverride = resolveCapOverride({
		...(input.maxCostUsdOverride !== undefined ? { overrideUsd: input.maxCostUsdOverride } : {}),
		frontmatter: baseAgent.frontmatter,
		...(projectDefaults?.maxCostUsd !== undefined
			? { projectDefaultUsd: projectDefaults.maxCostUsd }
			: {}),
	});
	const agent = withMaxCostUsdOverride(
		withProviderOverrides(baseAgent, {
			...(effectiveProvider !== undefined ? { providerOverride: effectiveProvider } : {}),
			...(effectiveModel !== undefined ? { modelOverride: effectiveModel } : {}),
		}),
		capOverride,
	);

	// Build the seed payload BEFORE creating the warren row so a malformed
	// expertise_seed / pi_skills / pi_prompts section surfaces as a clean
	// `RunSpawnError` with no half-spawned row to garbage-collect. Anything
	// burrow rejects later still rolls back via the try/catch below.
	const seedResult = buildSeedFiles(agent);

	// warren-76c5 / warren-3743: multi-worker placement is retired — the
	// self-host backend is a single local burrow. `runs.worker_id` is no longer
	// written (the workers/burrows tables were dropped); it stays NULL for new
	// runs and every reader (preview / proxy) treats NULL as the local worker.
	logPlacement(input.logger, WORKER_PLACEMENT_LABEL, projectAfterRefresh.id);

	const run = await input.repos.runs.create({
		agentName: agent.name,
		projectId: projectAfterRefresh.id,
		prompt: input.prompt,
		renderedAgentJson: agent,
		trigger: input.trigger ?? "manual",
		...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
		...(input.mode !== undefined ? { mode: input.mode } : {}),
		...(input.parentRunId !== undefined && input.parentRunId !== ""
			? { parentRunId: input.parentRunId, cloneKind: input.cloneKind ?? "continue" }
			: {}),
		...(targetBranch !== undefined ? { targetBranch } : {}),
		now: input.now?.(),
	});
	// warren-a0a2: expose the run id the instant the row exists so the cron
	// bounded-retry GC can reclaim it if the dispatch below throws (see types).
	input.onRunRowCreated?.(run.id);

	// warren-9993/a993: burrow branch = `${prefix}/${run.id}` (prefix precedence
	// project default > env > "burrow"); a CI-fixer run's `targetBranch` pins it
	// to the open PR head ref instead, so the fixer's commits re-run that PR's CI.
	const branch = composeRunBranch(
		resolveRunBranchPrefix({
			projectDefault: projectDefaults?.runBranchPrefix,
			envDefault: input.runBranchPrefixDefault,
		}),
		run.id,
		targetBranch,
	);

	const runEnv = composeRunEnv(run.id, projectDefaults?.qualityGate, input.serverEnv);

	// warren-b802: resolve per-project runtime override for the planner
	// interactive agent at dispatch time so the agent row
	// stays honest as 'builtin'.
	const runtimeOverride = interactiveRuntimeOverride(agent.name, projectDefaults);

	const log = bindRunLogger(input.logger, run.id);
	// Runtime-provider seam (warren-c42c: burrow-client eviction, bucket 2).
	// `provider.create` collapses burrow's provision + dispatch (`burrowsUp` +
	// `runs.create`) into one call and owns the sandbox-half rollback on a partial
	// failure (best-effort destroy + rethrow). The spawn path is now EXCLUSIVELY
	// the provider path — no burrow-direct fallback. Callers resolve the
	// boot-selected provider (`resolveRuntimeProvider`, honoring `WARREN_RUNTIME`)
	// and thread it in; there is no `burrowClient` on this seam to fall back to.
	const provider: RuntimeProvider = input.runtimeProvider;
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
		// warren-dac8: the RESOLVED base ref (explicit ref / targetBranch /
		// continuation parent branch), not blindly the project default branch.
		// The K8s init container cuts the workspace off `baseBranch`; a
		// ref-dispatch cut from the default branch misses the target ref's
		// tip and finalize's push reaps non-fast-forward (finalize_failed).
		baseBranch: baseRef ?? projectAfterRefresh.defaultBranch,
		hostClonePathHint: projectAfterRefresh.localPath,
		// warren-b6f2: project identity + per-project concurrency cap for K8s
		// admission control (design §3.3). The provider stamps the project label
		// and gates on the cap; LocalProvider ignores both.
		projectId: projectAfterRefresh.id,
		...(projectDefaults?.admission?.maxConcurrentRuns !== undefined
			? { maxProjectConcurrency: projectDefaults.admission.maxConcurrentRuns }
			: {}),
		// warren-aedd: carry the project's `.warren/config.yaml` `resources` block
		// (pod requests/limits/network defaults) onto the neutral RunSpec so the
		// K8sProvider's pod-spec resolution can fold it in. LocalProvider ignores it.
		...(projectDefaults?.resources !== undefined
			? { projectResources: projectDefaults.resources }
			: {}),
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
		logProvisioned(log, handle.sandboxId, WORKER_PLACEMENT_LABEL, dispatchStart);
		// warren-3743: the provider owns partial-failure cleanup, so the burrow
		// correlation ids are written back onto the run only after `create` fully
		// succeeds — a dispatch that fails mid-flight leaves no burrow_id on the
		// run (the provider already destroyed the burrow). These ids are
		// load-bearing for LocalProvider resume across a host restart.
		await input.repos.runs.attachBurrow(run.id, { burrowId: handle.sandboxId });
		const updated = await input.repos.runs.attachBurrow(run.id, {
			burrowRunId: handle.providerRunId,
		});
		logDispatched(log, handle.sandboxId, handle.providerRunId, dispatchStart);
		// warren-4e74: fire the observe-only `run_dispatched` lifecycle hook.
		// A no-op when no bus is installed (unit tests) or no extension
		// subscribes; a subscriber can neither mutate this payload nor stall
		// the dispatch (Tier-1 observe, warren-ext/v1).
		lifecycleBus()?.emitRunDispatched({
			runId: run.id,
			projectId: projectAfterRefresh.id,
			agentName: agent.name,
			branch,
			trigger: input.trigger ?? "manual",
			sandboxId: handle.sandboxId,
			providerRunId: handle.providerRunId,
		});
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
				logger: log,
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
		// The provider already destroyed any provisioned sandbox on a partial
		// failure (its create() owns the sandbox-half rollback), so the domain
		// rollback only unwinds the warren row (`persistSpawnFailure`).
		await rollback(input, run.id, log, err);
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
	targetBranch: string | undefined,
): Promise<string | undefined> {
	if (!input.parentRunId) return input.ref ?? targetBranch; // warren-709e
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
/** Merge quality-gate (warren-5797) and Bun cache relocation
 * (warren-b893) into the sandbox env. Always returns a non-empty object. */
function composeRunEnv(
	runId: string,
	qualityGate: string | undefined,
	serverEnv?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const env: Record<string, string> = { BUN_INSTALL_CACHE_DIR };
	if (qualityGate !== undefined) env.WARREN_QUALITY_GATE = qualityGate;
	// warren-57fd: inject a per-run SCOPED callback token (valid only for this
	// run's own inbox + finalize surface), not the operator bearer. See
	// callback-env.ts + run-token.ts for the trust-boundary rationale.
	injectWarrenCallbackEnv(env, serverEnv ?? process.env, runId);
	injectGitIdentityEnv(env, serverEnv ?? process.env);
	return env;
}

/**
 * Forward the operator's agent-commit identity (`WARREN_GIT_AUTHOR_NAME` /
 * `WARREN_GIT_AUTHOR_EMAIL`, see `.env.example`) into the sandbox as the four
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars git reads ahead of any config.
 *
 * On the Local path the supervisor already exports these into its own process
 * env (`src/supervisor/git-identity.ts`) and burrow passes them through, so
 * this is a no-op re-assertion of the same values. On the K8s path there is NO
 * supervisor and the run pod has no gitconfig at all — without this every
 * agent `git commit` dies with "Author identity unknown" exit 128 (hit live on
 * GKE, warren-4e36). Mirrors the supervisor's rule: both halves or nothing.
 */
function injectGitIdentityEnv(env: Record<string, string>, serverEnv: EnvLike): void {
	const name = serverEnv.WARREN_GIT_AUTHOR_NAME?.trim();
	const email = serverEnv.WARREN_GIT_AUTHOR_EMAIL?.trim();
	if (name === undefined || name === "" || email === undefined || email === "") return;
	env.GIT_AUTHOR_NAME = name;
	env.GIT_AUTHOR_EMAIL = email;
	env.GIT_COMMITTER_NAME = name;
	env.GIT_COMMITTER_EMAIL = email;
}

/**
 * Prefix the user's run prompt with the agent's `system` section so the
 * canopy-defined operating contract (workspace map, rituals, expectations)
 * actually reaches claude. Burrow's claude-code runtime feeds the dispatch
 * prompt to the agent as a single user turn — it never reads
 * `.warren/agent.json` itself, so without this prepend the canopy `system`
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

/**
 * `spawnRun` — composition flow (docs/design/agent-composition.md). Resolves the cached
 * agent, builds a neutral `RunSpec`, and dispatches via `provider.create(spec)`
 * (warren-c42c). The run row is created BEFORE `create`; `attachBurrow` writes
 * correlation ids only after success. A failed `create` rolls the row back
 * `failed`/`never_started`. Dispatch-context (warren-d6ca) snapshots right after.
 */

import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { resolveRunCostBasis } from "../../core/providers.ts";
import { withProjectCloneLock } from "../../projects/clone-lock.ts";
import { refreshProject } from "../../projects/manage.ts";
import {
	readProviderFrontmatter,
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
import { injectWarrenCallbackEnv } from "./callback-env.ts";
import { resolveContinuationRef, resolveExistingBranch } from "./continuation.ts";
import { writeDispatchContext } from "./dispatch-context.ts";
import { injectGitIdentityEnv, warnIfGitIdentityUnconfigured } from "./git-identity.ts";
import { healMigrationJournalCollisions, recordMigrationHealEvent } from "./migration-preflight.ts";
import { gateAgentPrompts } from "./prompt-capabilities.ts";
import { assertNoKnownProviderModelMismatch } from "./provider-model.ts";
import {
	bindRunLogger,
	logDispatched,
	logPlacement,
	logProvisioned,
	logSpawnFailed,
	rollback,
} from "./rollback.ts";
import { resolveSeedTracker, writeSeedExtensions } from "./seed-extensions.ts";
import type { SpawnRunInput, SpawnRunResult } from "./types.ts";

/**
 * Vestigial worker-placement label on the `spawn.placement` /
 * `spawn.provisioned` log lines (warren-c42c). Multi-worker placement was
 * retired with the K8s migration (warren-76c5 / warren-3743), so this is a
 * fixed log field, not a routing decision.
 */
const WORKER_PLACEMENT_LABEL = "local";

export async function spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
	if (input.prompt.trim() === "") {
		throw new ValidationError("prompt cannot be empty");
	}
	// warren-232d: serialize the per-project dispatch critical section — the
	// clone refresh (`checkout --force` / `reset --hard`), the working-tree
	// defaults read, and the provider's worktree materialization all mutate or
	// read the SAME shared host clone, so two concurrent dispatches on one
	// project with different base refs must not interleave. Different projects
	// dispatch in parallel; see src/projects/clone-lock.ts.
	return withProjectCloneLock(input.projectId, () => dispatchRun(input));
}

async function dispatchRun(input: SpawnRunInput): Promise<SpawnRunResult> {
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
	// warren-326f: the explicit opt-in to run on an EXISTING branch. Shape-validated
	// and fail-closed against the push remote BEFORE any side effect, then folded
	// into the repair-run pattern (branch = base ref = push target); see
	// resolveExistingBranch. Downstream keeps reading `ref`/`targetBranch`, so
	// providers and reap need no special-casing and default dispatches are
	// byte-identical.
	const existingBranch = await resolveExistingBranch(input, project);
	const baseRefField = existingBranch ?? input.ref;
	const pushTarget = existingBranch ?? targetBranch;

	const baseAgent = readCachedAgent(agentRow.renderedJson, agentRow.name);
	const burrowConfig = parseBurrowConfig(baseAgent.sections.burrow_config);

	// warren-4b11: continuation runs ("re-run with follow-up") seed their
	// workspace from the prior run's pushed branch instead of the project
	// default branch. Resolve the parent's branch up front and feed it as the
	// refresh ref so the local clone is checked out to the parent branch tip
	// before burrow forks the new run branch off it. The parent link is also
	// recorded on the new run row below so the UI can render a chain indicator
	// and chain cost/token totals are derivable by walking the link.
	const baseRef = input.baseCommit ?? (await resolveContinuationRef(input, project, pushTarget));

	// warren-232d: a baseCommit dispatch NEVER moves the host clone's HEAD.
	// The refresh runs in fetch-only mode (the pinned SHA's objects come
	// down, HEAD/working tree untouched — see refreshProjectClone's
	// `fetchCommit` leg) and the workspace is cut at the SHA directly by
	// the provider (`git worktree add -b <runBranch> <ws> <sha>`), so the
	// shared clone's checked-out branch never moves for a pinned replay.
	const refreshed =
		input.projectsConfig !== undefined && input.projectSpawn !== undefined
			? await (input.refreshProjectFn ?? refreshProject)({
					repo: input.repos.projects,
					config: input.projectsConfig,
					id: project.id,
					...(input.baseCommit !== undefined
						? { fetchCommit: input.baseCommit }
						: baseRef !== undefined
							? { ref: baseRef }
							: {}),
					gitCredential: input.gitCredential,
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
	// warren-cb46: gate tracker/mulch prompt fragments on the project's real
	// capabilities before anything freezes the agent (prompt-capabilities.ts).
	const agent = gateAgentPrompts(
		withMaxCostUsdOverride(
			withProviderOverrides(baseAgent, {
				...(effectiveProvider !== undefined ? { providerOverride: effectiveProvider } : {}),
				...(effectiveModel !== undefined ? { modelOverride: effectiveModel } : {}),
			}),
			capOverride,
		),
		projectAfterRefresh,
		input.issueTracker,
	);
	// warren-bad5: validate only after the override > project default >
	// agent frontmatter chain has been fully resolved.
	const { provider: declaredProvider, model: declaredModel } = readProviderFrontmatter(
		agent.frontmatter,
	);
	assertNoKnownProviderModelMismatch(declaredProvider, declaredModel);

	// Build the seed payload BEFORE creating the warren row so a malformed
	// expertise_seed / pi_skills / pi_prompts section surfaces as a clean
	// `RunSpawnError` with no half-spawned row to garbage-collect. Anything
	// burrow rejects later still rolls back via the try/catch below.
	const seedResult = buildSeedFiles(agent);

	// warren-76c5 / warren-3743: multi-worker placement is retired — the
	// self-host backend is a single local burrow. `runs.worker_id` is no longer
	// written (the workers/sandboxes tables were dropped); it stays NULL for new
	// runs and every reader (preview / proxy) treats NULL as the local worker.
	logPlacement(input.logger, WORKER_PLACEMENT_LABEL, projectAfterRefresh.id);

	// warren-2ede / pl-103e: freeze the DECLARED provider/model onto real
	// columns so analytics group-bys read the columns instead of re-parsing
	// rendered_agent_json per query. This is the resolved frontmatter value
	// (override chain already folded in above), not what the harness used.
	const run = await input.repos.runs.create({
		agentName: agent.name,
		projectId: projectAfterRefresh.id,
		prompt: input.prompt,
		renderedAgentJson: agent,
		...(declaredProvider !== undefined ? { provider: declaredProvider } : {}),
		...(declaredModel !== undefined ? { model: declaredModel } : {}),
		// warren-f3c3: freeze how the run's cost will be priced. A run whose
		// anthropic credential is CLAUDE_CODE_OAUTH_TOKEN (subscription auth)
		// gets `subscription_estimate` so costUsd reads as an estimate, not a
		// bill. Resolved beside the provider env registry (core/providers.ts).
		costBasis: resolveRunCostBasis(declaredProvider, input.serverEnv ?? process.env),
		trigger: input.trigger ?? "manual",
		...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
		...(input.mode !== undefined ? { mode: input.mode } : {}),
		...(input.parentRunId !== undefined && input.parentRunId !== ""
			? { parentRunId: input.parentRunId, cloneKind: input.cloneKind ?? "continue" }
			: {}),
		...(input.retryOf !== undefined && input.retryOf !== "" ? { retryOf: input.retryOf } : {}),
		...(pushTarget !== undefined ? { targetBranch: pushTarget } : {}),
		// warren-afeb: freeze the explicit dispatch-supplied clone ref onto the
		// row so POST /runs and GET /runs/:id can echo that it took.
		...(baseRefField !== undefined ? { ref: baseRefField } : {}),
		// warren-aaf7: freeze the base-commit pin so the projections can echo
		// it; the PR base resolution (reap) reads `ref` only, never this.
		...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
		now: input.now?.(),
	});
	// warren-a0a2: expose the run id the instant the row exists so the cron
	// bounded-retry GC can reclaim it if the dispatch below throws (see types).
	input.onRunRowCreated?.(run.id);

	// warren-d6ca: dispatch-context snapshot BEFORE any runtime contact so a
	// never-started failure still gets a row. Fire-and-log — see writeDispatchContext.
	await writeDispatchContext({
		spawn: input,
		run,
		agent,
		baseAgent,
		declaredProvider,
		declaredModel,
		projectDefaults,
		network: burrowConfig.network ?? "none",
	});

	// warren-9993/a993: burrow branch = `${prefix}/${run.id}` (prefix precedence
	// project default > env > built-in "warren" default); a CI-fixer run's `targetBranch` pins it
	// to the open PR head ref instead, so the fixer's commits re-run that PR's CI.
	const branch = composeRunBranch(
		resolveRunBranchPrefix({
			projectDefault: projectDefaults?.runBranchPrefix,
			envDefault: input.runBranchPrefixDefault,
		}),
		run.id,
		pushTarget,
	);

	const runEnv = composeRunEnv(run.id, projectDefaults?.qualityGate, input.serverEnv);

	// warren-b802: per-project runtime override (planner stays 'builtin').
	const runtimeOverride = interactiveRuntimeOverride(agent.name, projectDefaults);
	const runtimeId = readRuntimeId(agent, runtimeOverride);

	// warren-9ce3: read dispatcherHandle + dispatchOrigin (were dropped silently).
	const log = bindRunLogger(input.logger, run.id, {
		dispatcherHandle: input.dispatcherHandle,
		dispatchOrigin: input.dispatchOrigin,
	});
	// warren-e7b7: warn once per dispatch when agent git identity is unset (K8s).
	warnIfGitIdentityUnconfigured(log, input.serverEnv ?? process.env);
	// Runtime-provider seam (warren-c42c: burrow-client eviction, bucket 2).
	// `provider.create` collapses burrow's provision + dispatch (`sandboxUp` +
	// `runs.create`) into one call and owns the sandbox-half rollback on a partial
	// failure (best-effort destroy + rethrow). The spawn path is now EXCLUSIVELY
	// the provider path — no burrow-direct fallback. Callers resolve the
	// boot-selected provider (`resolveRuntimeProvider`, honoring `WARREN_RUNTIME`)
	// and thread it in; there is no `sandboxClient` on this seam to fall back to.
	const provider: RuntimeProvider = input.runtimeProvider;
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
		// warren-fabb: per-project agent image override (docker + k8s consume it;
		// LocalProvider ignores it — host toolchain). Precedence: project override
		// > WARREN_DOCKER_AGENT_IMAGE / WARREN_K8S_AGENT_IMAGE env > default.
		...(projectDefaults?.agentImage !== undefined
			? { agentImage: projectDefaults.agentImage }
			: {}),
		runtimeId,
		prompt: composeDispatchPrompt(
			agent.sections.system,
			input.prompt,
			projectDefaults?.repoContext,
		),
		metadata: composeBurrowMetadata(input.metadata, agent.frontmatter),
		mode: input.mode ?? "batch",
		network: burrowConfig.network ?? "none",
		seedFiles: seedResult.files,
		env: runEnv,
	};
	try {
		// warren-5255: freeze the composed workspace branch onto the row so
		// HTTP consumers (the campaign-controller's cross-fork head ref) read
		// it instead of re-deriving the prefix composition. Inside the try so
		// a failure unwinds through the same rollback as the dispatch itself.
		await input.repos.runs.setBranch(run.id, branch);
		// warren-1f03: dispatch-time drizzle migration preflight. A ref-dispatch
		// onto an existing branch whose generated migrations collide with a
		// journal slot main landed after the branch was cut is healed prompt-free
		// (colliding artifacts deleted, `bun run db:generate`, heal commit on the
		// host clone branch) BEFORE the provider forks the workspace. A fresh
		// dispatch from the default branch cannot collide, so it is skipped.
		// warren-232d: a baseCommit dispatch skips the preflight too — its host
		// clone was NOT checked out onto the base ref (fetch-only refresh), so
		// the heal path would commit onto whatever branch the clone happens to
		// sit on (or a detached HEAD), not the pinned base.
		if (
			refreshed !== null &&
			input.baseCommit === undefined &&
			baseRef !== undefined &&
			baseRef !== projectAfterRefresh.defaultBranch &&
			input.projectSpawn !== undefined
		) {
			const heal = await (input.migrationHealFn ?? healMigrationJournalCollisions)({
				spawn: input.projectSpawn,
				projectPath: projectAfterRefresh.localPath,
				defaultBranch: projectAfterRefresh.defaultBranch,
				baseRef,
				...(input.projectsConfig?.gitBinary !== undefined
					? { gitBinary: input.projectsConfig.gitBinary }
					: {}),
				...(input.serverEnv !== undefined ? { env: input.serverEnv } : {}),
			});
			if (heal.collisions.length > 0) {
				log.info(
					{ collisions: heal.collisions, commit_sha: heal.commitSha, base_ref: baseRef },
					"spawn.migration_journal_heal",
				);
				await recordMigrationHealEvent(
					input.repos,
					run.id,
					heal,
					baseRef,
					input.now?.() ?? new Date(),
				);
			}
		}
		const dispatchStart = Date.now();
		const handle = await provider.create(spec);
		logProvisioned(log, handle.sandboxId, WORKER_PLACEMENT_LABEL, dispatchStart);
		// warren-3743: the provider owns partial-failure cleanup, so the burrow
		// correlation ids are written back onto the run only after `create` fully
		// succeeds — a dispatch that fails mid-flight leaves no sandbox_id on the
		// run (the provider already destroyed the burrow). These ids are
		// load-bearing for LocalProvider resume across a host restart.
		await input.repos.runs.attachBurrow(run.id, { sandboxId: handle.sandboxId });
		const updated = await input.repos.runs.attachBurrow(run.id, {
			sandboxRunId: handle.providerRunId,
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
		// pl-bb70 step 4 + warren-6234: stamp the run's tracker metadata
		// after dispatch via the IssueTracker seam, fire-and-log (see
		// seed-extensions.ts). A legacy `seedsCli` (plan-runs port pending,
		// warren-2d98) wraps in SeedsTracker here.
		const seedTracker = resolveSeedTracker(input.issueTracker, input.seedsCli);
		if (input.seedId !== undefined && seedTracker !== undefined) {
			await writeSeedExtensions({
				repos: input.repos,
				issueTracker: seedTracker,
				projectId: projectAfterRefresh.id,
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
		// UI, slated for removal with the multi-worker/`/sandboxes` surface (plan
		// §5.C); no value is available across the seam, so it is empty here.
		return {
			run: updated,
			sandbox: { id: handle.sandboxId, workspacePath: "" },
			sandboxRun: { id: handle.providerRunId },
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

// warren-4e36 / warren-e7b7: the git-identity env helpers moved to
// `./git-identity.ts` (size budget, warren-4553).

/**
 * Prefix the user's run prompt with the agent's `system` section so the
 * canopy-defined operating contract (workspace map, rituals, expectations)
 * actually reaches claude. Burrow's claude-code runtime feeds the dispatch
 * prompt to the agent as a single user turn — it never reads
 * `.warren/agent.json` itself, so without this prepend the canopy `system`
 * body is dead text on disk.
 *
 * `runs.prompt` (warren-side) keeps the user-typed input verbatim; only
 * the body sent on POST /sandboxes/:id/runs is composed.
 */
export function composeDispatchPrompt(
	systemBody: string | undefined,
	userPrompt: string,
	repoContext?: string,
): string {
	const trimmed = (systemBody ?? "").trim();
	// warren-540f: the project's `.warren/config.yaml` `repoContext` block
	// rides between the system section and the user prompt, clearly
	// delimited. Absent/whitespace-only → byte-identical to the pre-540f
	// composition.
	const context = (repoContext ?? "").trim();
	const parts = [trimmed, context].filter((part) => part !== "");
	if (parts.length === 0) return userPrompt;
	return `${parts.join("\n\n---\n\n")}\n\n---\n\n${userPrompt}`;
}

/** Fold agent frontmatter onto operator metadata (burrow-b5b4 / warren-618b). */
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

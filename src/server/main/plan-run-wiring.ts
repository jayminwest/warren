/**
 * Plan-run coordinator boot wiring (pl-a258 / warren-2623). Extracted
 * from `bootServer` in `index.ts` so the orchestrator stays under the
 * per-file size budget, mirroring the sibling `*-wiring.ts` precedent
 * (preview-wiring.ts, detector-wiring.ts, observability-wiring.ts).
 *
 * Polls active `plan_runs` rows on a 10s tick by default; same
 * single-flight + disabled-via-env shape as `bootScheduler` so operators
 * reading logs see identical lifecycle semantics. Returns the coordinator
 * handle so the caller can call `.stop()` on it in teardown.
 */

import type { Repos } from "../../db/repos/index.ts";
import {
	bootPlanRunCoordinator,
	type CoordinatorCloseChildSeedFn,
	closeMergedChildSeed,
	createPlanRunSpawn,
	createPrMergeChecker,
	createResolveExecution,
	loadPlanRunCoordinatorConfigFromEnv,
	type PlanRunCoordinatorHandle,
} from "../../plan-runs/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import { parseGitHubUrl } from "../../projects/index.ts";
import {
	type AutoOpenPrConfig,
	composeRunBranch,
	resolveRunBranchPrefix,
} from "../../runs/index.ts";
import { buildPrContent, openPullRequest } from "../../runs/pr.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import { showSeed } from "../../seeds-cli/index.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { EnvLike } from "../config.ts";
import type { BridgeRegistry, Logger } from "../types.ts";
import { planRunLoggerFromPino } from "./logging.ts";

type ReopenPrDeps = Pick<
	PlanRunWiringInput,
	"repos" | "warrenConfigs" | "autoOpenPr" | "runBranchPrefixDefault" | "logger"
>;

type RunRow = NonNullable<Awaited<ReturnType<Repos["runs"]["get"]>>>;

/** Build the optional `buildPrContent` fields (only-if-present spreads). */
function buildReopenPrContent(
	run: RunRow,
	autoOpenPr: AutoOpenPrConfig,
): { title: string; body: string } {
	const content = buildPrContent({
		prompt: run.prompt,
		runId: run.id,
		agentName: run.agentName,
		...(run.startedAt !== null ? { startedAt: run.startedAt } : {}),
		...(run.endedAt !== null ? { endedAt: run.endedAt } : {}),
		...(run.costUsd !== null ? { costUsd: run.costUsd } : {}),
		...(run.tokensInput !== null ? { tokensInput: run.tokensInput } : {}),
		...(run.tokensOutput !== null ? { tokensOutput: run.tokensOutput } : {}),
		...(run.tokensCacheRead !== null ? { tokensCacheRead: run.tokensCacheRead } : {}),
		...(autoOpenPr.warrenBaseUrl !== null ? { warrenBaseUrl: autoOpenPr.warrenBaseUrl } : {}),
	});
	return { title: content.title, body: content.body };
}

/**
 * Build the `reopenPr` coordinator seam — reopens a run's PR when auto-open
 * is enabled. Returns `undefined` when auto-open is disabled / tokenless.
 */
function createReopenPr(
	deps: ReopenPrDeps,
): ((runId: string) => Promise<string | null>) | undefined {
	const { repos, warrenConfigs, autoOpenPr, runBranchPrefixDefault, logger } = deps;
	if (!autoOpenPr.enabled || autoOpenPr.token === "") return undefined;
	return async (runId: string): Promise<string | null> => {
		try {
			const run = await repos.runs.get(runId);
			if (run === null || run.projectId === null) return null;
			const project = await repos.projects.get(run.projectId);
			if (project === null) return null;
			const warrenConfig = await warrenConfigs.get(run.projectId, project.localPath);
			const prefix = resolveRunBranchPrefix({
				projectDefault: warrenConfig.defaults?.runBranchPrefix,
				envDefault: runBranchPrefixDefault,
			});
			const branch = composeRunBranch(prefix, runId);
			const parsed = parseGitHubUrl(project.gitUrl);
			const content = buildReopenPrContent(run, autoOpenPr);
			const result = await openPullRequest({
				owner: parsed.owner,
				repo: parsed.name,
				head: branch,
				base: project.defaultBranch,
				title: content.title,
				body: content.body,
				token: autoOpenPr.token,
			});
			if (result.ok) return result.url;
			logger.warn(
				{ runId, reason: result.reason, message: result.message },
				"plan_run.reopen_pr_failed",
			);
			return null;
		} catch (err) {
			logger.warn(
				{ runId, reason: err instanceof Error ? err.message : String(err) },
				"plan_run.reopen_pr_error",
			);
			return null;
		}
	};
}

type CloseChildSeedDeps = Pick<
	PlanRunWiringInput,
	"env" | "repos" | "projectsConfig" | "seedsCli" | "projectSpawn" | "logger"
>;

/**
 * Build the host-side child-seed close seam (warren-3806). Fired the instant
 * a plan-run child transitions to `merged`; deterministically closes the
 * child's seed on the coordination project's default branch using
 * WARREN_BOT_IDENTITY. Best-effort — any failure is logged and swallowed so
 * the plan keeps advancing (mirrors the Plot auto-done hook's tolerance).
 */
function createCloseChildSeed(deps: CloseChildSeedDeps): CoordinatorCloseChildSeedFn {
	const { env, repos, projectsConfig, seedsCli, projectSpawn, logger } = deps;
	return async ({ planRun, child }) => {
		try {
			const project = await repos.projects.get(planRun.projectId);
			if (project === null || !project.hasSeeds) return;
			const result = await closeMergedChildSeed({
				projectPath: project.localPath,
				defaultBranch: project.defaultBranch,
				seedId: child.seedId,
				seedsCli,
				spawn: projectSpawn,
				gitBinary: projectsConfig.gitBinary,
				// Raw token so the fetch/push work against private repos on
				// the K8s control plane (no supervisor insteadOf rule there).
				githubToken: env.GITHUB_TOKEN,
			});
			logger.info(
				{ planRunId: planRun.id, seq: child.seq, seedId: child.seedId, outcome: result.kind },
				"plan_run.child_seed_closed",
			);
		} catch (err) {
			logger.warn(
				{
					planRunId: planRun.id,
					seq: child.seq,
					seedId: child.seedId,
					reason: err instanceof Error ? err.message : String(err),
				},
				"plan_run.child_seed_close_failed",
			);
		}
	};
}

export interface PlanRunWiringInput {
	readonly env: EnvLike;
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly autoOpenPr: AutoOpenPrConfig;
	readonly runBranchPrefixDefault?: string;
	readonly seedsCli: SeedsCliDeps;
	readonly projectSpawn: SpawnFn;
	readonly logger: Logger;
	readonly now?: () => Date;
}

/**
 * Boot the plan-run coordinator (pl-a258 / warren-2623). Loads its
 * env-driven config, constructs the coordinator (including the reopen-PR
 * closure), emits the disabled/running log itself,
 * and returns the handle for teardown.
 */
export function bootPlanRunCoordinatorWiring(input: PlanRunWiringInput): PlanRunCoordinatorHandle {
	const {
		env,
		repos,
		runtimeProvider,
		bridges,
		warrenConfigs,
		projectsConfig,
		autoOpenPr,
		runBranchPrefixDefault,
		seedsCli,
		projectSpawn,
		logger,
		now,
	} = input;

	const planRunCoordinatorConfig = loadPlanRunCoordinatorConfigFromEnv(env);
	const planRunCoordinator = bootPlanRunCoordinator({
		repos,
		showSeed: async (projectId, seedId) => {
			const project = await repos.projects.require(projectId);
			return showSeed(seedsCli, project.localPath, seedId);
		},
		checkPrMerged: createPrMergeChecker({ token: autoOpenPr.token }),
		resolveExecution: createResolveExecution(repos), // pl-fb43 step 5: per-child execution repo
		// warren-3806: deterministic host-side seed close when a child merges.
		closeChildSeed: createCloseChildSeed({
			env,
			repos,
			projectsConfig,
			seedsCli,
			projectSpawn,
			logger,
		}),
		reopenPr: createReopenPr({
			repos,
			warrenConfigs,
			autoOpenPr,
			logger,
			...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		}),
		spawn: createPlanRunSpawn({
			repos,
			runtimeProvider,
			bridges,
			warrenConfigs,
			projectsConfig,
			projectSpawn,
			// Raw token for the pre-dispatch refresh fetch (private repos on
			// the K8s control plane) — see SpawnRunInput.githubToken.
			githubToken: env.GITHUB_TOKEN,
			seedsCli,
			...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
			...(now !== undefined ? { now } : {}),
		}),
		tickMs: planRunCoordinatorConfig.tickMs,
		disabled: planRunCoordinatorConfig.disabled,
		mergeTimeoutMs: planRunCoordinatorConfig.mergeTimeoutMs,
		logger: planRunLoggerFromPino(logger),
		...(now !== undefined ? { now } : {}),
	});
	if (planRunCoordinatorConfig.disabled) {
		logger.info({}, "plan-run coordinator disabled via WARREN_PLAN_RUN_DISABLED");
	} else {
		logger.info({ tickMs: planRunCoordinatorConfig.tickMs }, "plan-run coordinator running");
	}
	return planRunCoordinator;
}

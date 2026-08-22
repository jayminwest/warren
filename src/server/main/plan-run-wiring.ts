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
import type { Forge } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import {
	bootPlanRunCoordinator,
	type CoordinatorCloseChildSeedFn,
	closeMergedChildSeed,
	createPlanRunSpawn,
	createPrMergeChecker,
	loadPlanRunCoordinatorConfigFromEnv,
	type PlanRunCoordinatorHandle,
} from "../../plan-runs/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import {
	type AutoOpenPrConfig,
	composeRunBranch,
	resolveRunBranchPrefix,
} from "../../runs/index.ts";
import { buildPrContent } from "../../runs/pr.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import { SeedsTracker } from "../../tracker/seeds-tracker.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { EnvLike } from "../config.ts";
import type { BridgeRegistry, Logger } from "../types.ts";
import { planRunLoggerFromPino } from "./logging.ts";

type ReopenPrDeps = Pick<
	PlanRunWiringInput,
	"repos" | "warrenConfigs" | "autoOpenPr" | "forge" | "runBranchPrefixDefault" | "logger"
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
	const { repos, warrenConfigs, autoOpenPr, forge, runBranchPrefixDefault, logger } = deps;
	// warren-63e7: the token-presence conjunct died with the captured token.
	// A credential-less forge surfaces `no_credential` from openPullRequest
	// (logged below, reopen skipped) — same net behavior, no §5 conditional.
	if (!autoOpenPr.enabled) return undefined;
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
			// warren-45e6: the reopen crosses the Forge seam. parseRepoRef never
			// throws — null means no forge owns the URL, logged + skipped.
			const ref = forge.parseRepoRef(project.gitUrl);
			if (ref === null) {
				logger.warn({ runId }, "plan_run.reopen_pr_unowned_url");
				return null;
			}
			const content = buildReopenPrContent(run, autoOpenPr);
			const result = await forge.openPullRequest(ref, {
				headBranch: branch,
				// warren-8cbf: the reopened PR targets the same base reap would
				// have used — the run's frozen clone ref, else the default branch.
				baseBranch: run.ref ?? project.defaultBranch,
				title: content.title,
				body: content.body,
			});
			if (result.ok) return result.value.webUrl;
			logger.warn(
				{ runId, kind: result.error.kind, detail: result.error.detail },
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
	"forge" | "repos" | "projectsConfig" | "projectSpawn" | "logger"
> & {
	/** warren-6234: the close runs through the tracker seam. */
	readonly issueTracker: IssueTracker;
};

/**
 * Build the host-side child-seed close seam (warren-3806). Fired the instant
 * a plan-run child transitions to `merged`; deterministically closes the
 * child's seed on the coordination project's default branch using
 * WARREN_BOT_IDENTITY. Best-effort — any failure is logged and swallowed so
 * the plan keeps advancing (mirrors the Plot auto-done hook's tolerance).
 */
function createCloseChildSeed(deps: CloseChildSeedDeps): CoordinatorCloseChildSeedFn {
	const { forge, repos, projectsConfig, issueTracker, projectSpawn, logger } = deps;
	return async ({ planRun, child }) => {
		try {
			const project = await repos.projects.get(planRun.projectId);
			if (project === null) return;
			// warren-53ea: the hasSeeds gate applies only to a GIT-NATIVE tracker
			// (seeds state lives in the clone). A non-git-native tracker closes
			// through its host API — closeMergedChildSeed's isGitNative arm — and
			// needs no clone state at all. Gating it on hasSeeds would suppress
			// the close entirely for tracker-served projects (caught by
			// acceptance scenario 43).
			if (issueTracker.capabilities.isGitNative && !project.hasSeeds) return;
			// warren-63e7: mint the fetch/push credential from the forge
			// immediately before the git spawns (forge-contract.md §4 — minted,
			// never held) instead of reading a boot-captured env.GITHUB_TOKEN.
			// Undefined → anonymous git, the old no-token behavior.
			const gitSecret = await mintGitCredential(forge, project.gitUrl);
			const result = await closeMergedChildSeed({
				projectPath: project.localPath,
				defaultBranch: project.defaultBranch,
				seedId: child.seedId,
				projectId: planRun.projectId,
				issueTracker,
				spawn: projectSpawn,
				gitBinary: projectsConfig.gitBinary,
				// Minted per close so the fetch/push work against private repos
				// on the K8s control plane (no supervisor insteadOf rule there).
				gitCredential: gitSecret,
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
	/** Boot-resolved forge (warren-45e6) — the reopen-PR seam runs through it. */
	readonly forge: Forge;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly autoOpenPr: AutoOpenPrConfig;
	readonly runBranchPrefixDefault?: string;
	readonly seedsCli: SeedsCliDeps;
	/** Boot-resolved IssueTracker (warren-5819) — forwarded to the child-dispatch spawn. */
	readonly issueTracker?: IssueTracker;
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
		forge,
		bridges,
		warrenConfigs,
		projectsConfig,
		autoOpenPr,
		runBranchPrefixDefault,
		seedsCli,
		issueTracker,
		projectSpawn,
		logger,
		now,
	} = input;

	const planRunCoordinatorConfig = loadPlanRunCoordinatorConfigFromEnv(env);
	const planRunCoordinator = bootPlanRunCoordinator({
		repos,
		// warren-2d98: the coordinator's issue reads bind from the tracker
		// seam — boot always wires a SeedsTracker, and the fallback keeps
		// direct constructions of this wiring (tests) working when only the
		// legacy facade is supplied.
		getIssue: async (projectId, issueId) => {
			const project = await repos.projects.require(projectId);
			const tracker = issueTracker ?? new SeedsTracker(seedsCli);
			return tracker.getIssue({ projectId, localPath: project.localPath }, issueId);
		},
		// warren-63e7: the merge gate consumes the boot-resolved forge — no
		// closure-captured token can ride a multi-hour poll loop anymore.
		checkPrMerged: createPrMergeChecker({ forge, logger }),
		// warren-3806: deterministic host-side seed close when a child merges.
		closeChildSeed: createCloseChildSeed({
			forge,
			repos,
			projectsConfig,
			// warren-6234: the child-seed close runs through the tracker seam.
			issueTracker: issueTracker ?? new SeedsTracker(seedsCli),
			projectSpawn,
			logger,
		}),
		reopenPr: createReopenPr({
			repos,
			warrenConfigs,
			autoOpenPr,
			forge,
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
			forge,
			seedsCli,
			...(issueTracker !== undefined ? { issueTracker } : {}),
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

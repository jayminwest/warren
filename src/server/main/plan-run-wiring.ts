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
import type { Forge, PullRequestRef, RepoRef } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import {
	bootPlanRunCoordinator,
	type CoordinatorCloseChildSeedFn,
	closeMergedChildSeed,
	createMergeStallProbe,
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
import { runAutoMergeArm } from "../../runs/reap/auto-merge-arm.ts";
import type { ReapExec } from "../../runs/reap/types.ts";
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
	| "repos"
	| "warrenConfigs"
	| "autoOpenPr"
	| "forge"
	| "runBranchPrefixDefault"
	| "projectSpawn"
	| "now"
	| "logger"
>;

type RunRow = NonNullable<Awaited<ReturnType<Repos["runs"]["get"]>>>;
type ProjectRow = NonNullable<Awaited<ReturnType<Repos["projects"]["get"]>>>;

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
 * Exported for the co-located reopen-arm test (warren-14d6).
 */
export function createReopenPr(
	deps: ReopenPrDeps,
): ((runId: string) => Promise<string | null>) | undefined {
	const { autoOpenPr, logger } = deps;
	// warren-63e7: the token-presence conjunct died with the captured token.
	// A credential-less forge surfaces `no_credential` from openPullRequest
	// (logged below, reopen skipped) — same net behavior, no §5 conditional.
	if (!autoOpenPr.enabled) return undefined;
	return async (runId: string): Promise<string | null> => {
		try {
			return await reopenPrForRun(deps, runId);
		} catch (err) {
			logger.warn(
				{ runId, reason: err instanceof Error ? err.message : String(err) },
				"plan_run.reopen_pr_error",
			);
			return null;
		}
	};
}

/**
 * The reopen body, extracted from the seam closure to keep both under the
 * cognitive-complexity budget (warren-d3a6). Resolves the run → project →
 * branch, opens the PR through the Forge seam, and — on success — arms it
 * (warren-14d6) before returning the new URL.
 */
async function reopenPrForRun(deps: ReopenPrDeps, runId: string): Promise<string | null> {
	const { repos, warrenConfigs, autoOpenPr, forge, runBranchPrefixDefault, logger } = deps;
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
	const baseBranch = run.ref ?? project.defaultBranch;
	const result = await forge.openPullRequest(ref, {
		headBranch: branch,
		// warren-8cbf: the reopened PR targets the same base reap would
		// have used — the run's frozen clone ref, else the default branch.
		baseBranch,
		title: content.title,
		body: content.body,
	});
	if (result.ok) {
		// warren-14d6 (pl-92a3 step 6): a reopened child PR arms exactly the
		// way a reaped one does — through the SAME `runAutoMergeArm`, never a
		// copy (AGENTS.md "Single source of truth").
		await armReopenedPr(deps, {
			run,
			project,
			ref,
			prRef: result.value,
			branch,
			baseBranch,
		});
		return result.value.webUrl;
	}
	logger.warn(
		{ runId, kind: result.error.kind, detail: result.error.detail },
		"plan_run.reopen_pr_failed",
	);
	return null;
}

/** The reopened PR the arm sub-step targets (warren-14d6). */
interface ReopenedPrArmTarget {
	readonly run: RunRow;
	readonly project: ProjectRow;
	readonly ref: RepoRef;
	readonly prRef: PullRequestRef;
	readonly branch: string;
	readonly baseBranch: string;
}

/**
 * Arm auto-merge on a PR the reopen seam just opened (warren-14d6). Routed
 * through the same `runAutoMergeArm` the reap PR-open sub-step calls, so a
 * reopened child PR arms identically to a reaped one. Fully isolated from
 * the reopen outcome: the arm is best-effort by contract (it cannot throw,
 * cannot change run state, and stays silent when the project never opted
 * in), and this wrapper catches even a config-load failure so the reopen's
 * own return value — the PR URL — is never held hostage by arming.
 */
async function armReopenedPr(deps: ReopenPrDeps, target: ReopenedPrArmTarget): Promise<void> {
	const { repos, warrenConfigs, forge, projectSpawn, logger, now } = deps;
	const { run, project } = target;
	try {
		const config = await warrenConfigs.get(project.id, project.localPath);
		await runAutoMergeArm({
			projectAutoMerge: config.defaults?.pr?.autoMerge ?? undefined,
			run: { id: run.id, trigger: run.trigger },
			project: { gitUrl: project.gitUrl, localPath: project.localPath },
			prUrl: target.prRef.webUrl,
			prNumber: target.prRef.number,
			repoRef: target.ref,
			prRef: target.prRef,
			branch: target.branch,
			baseBranch: target.baseBranch,
			// The reopen seam runs host-side after the workspace is gone, so the
			// arm takes its no-workspace path: it fetches the pushed branch into
			// the project clone before the policy's diff read.
			workspacePath: null,
			forge,
			exec: execFromSpawn(projectSpawn),
			emit: async (kind, payload) => {
				const seq = ((await repos.events.maxSeqForRun(run.id)) ?? 0) + 1;
				await repos.events.append({
					runId: run.id,
					sandboxEventSeq: seq,
					ts: (now?.() ?? new Date()).toISOString(),
					kind,
					stream: "system",
					payload,
				});
			},
		});
	} catch (err) {
		logger.warn(
			{ runId: run.id, reason: err instanceof Error ? err.message : String(err) },
			"plan_run.reopen_pr_arm_error",
		);
	}
}

/**
 * Adapt the boot-wired `SpawnFn` onto the `ReapExec` shape the arm step
 * reads git through — same `{ cwd, timeoutMs?, env? }` options, rejection
 * on a non-zero exit so `ReapExec` consumers keep their fail-closed reads.
 */
function execFromSpawn(spawn: SpawnFn): ReapExec {
	return {
		run: async (cmd, args, opts) => {
			const result = await spawn([cmd, ...args], {
				cwd: opts.cwd,
				...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
				...(opts.env !== undefined ? { env: opts.env } : {}),
			});
			if (result.exitCode !== 0) {
				const first = (args[0] ?? "").split(" ")[0] ?? "";
				throw new Error(result.stderr.trim() || `${cmd} ${first} exited ${result.exitCode}`);
			}
			return { stdout: result.stdout, stderr: result.stderr };
		},
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
		// pl-92a3 step 7: one-shot stall warning on a green PR with no armed
		// auto-merge, and the same diagnosis on a merge-timeout failure.
		probeMergeStall: createMergeStallProbe({ forge }),
		mergeStallWarningMs: planRunCoordinatorConfig.mergeStallWarningMs,
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
			projectSpawn,
			logger,
			...(now !== undefined ? { now } : {}),
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

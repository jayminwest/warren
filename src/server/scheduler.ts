/**
 * Scheduler boot — wires the R-06 tick loop into `bootServer`'s lifecycle.
 *
 * One in-process tick fires every `tickMs` (default 60s), walks every
 * project, dispatches cron entries + scheduled-for seeds via `spawnRun`,
 * and persists fire state in the `triggers` table. The tick is
 * single-flight (mx-eb4a3a): a tick already in flight when the next
 * interval fires is skipped, so a slow tick degrades effective cadence
 * but never duplicates fires.
 *
 * Shape mirrors `bootBridges` in ./bridges.ts: a builder that takes the
 * bag of server deps and returns a `SchedulerHandle`. `bootServer`
 * invokes the returned `stop()` BEFORE bridges/burrow/db go away so an
 * in-flight tick (which may be calling `spawnRun` against burrow) drains
 * before its deps disappear.
 *
 * The scheduler's per-fire dispatch wraps `spawnRun` exactly like
 * `POST /runs` does: same agent lookup, same burrow provisioning, same
 * workspace seed, same bridge hand-off so the scheduled run's events
 * flow into warren.events without the operator manually attaching a
 * bridge.
 */

import type { Repos } from "../db/repos/index.ts";
import type { Forge } from "../forge/contract.ts";
import { mintGitCredential } from "../forge/credentials.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { spawnRun } from "../runs/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import {
	CronRetryTracker,
	createProjectCloneHealer,
	type DispatchSpawnFn,
	type DispatchSpawnInput,
	type DispatchSpawnResult,
	ProjectHealTracker,
	type SchedulerHandle,
	type SchedulerTimerHandle,
	startScheduler,
	type TickCiFixerSpawnFn,
	type TickCiFixerSpawnInput,
	type TickLogger,
	type TriggerSchedulerConfig,
} from "../triggers/index.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";
import type { BridgeRegistry } from "./types.ts";

export interface BootSchedulerInput {
	readonly repos: Repos;
	/**
	 * Resolved runtime provider (warren-c42c: required — the spawn seam is now
	 * exclusively `provider.create()`, no burrow-client fallback). Boot threads
	 * the boot-selected instance (`resolveRuntimeProvider`, honoring
	 * `WARREN_RUNTIME`) — the same one `POST /runs` dispatches through — so
	 * cron/scheduled-for/CI-fixer fires all honor `WARREN_RUNTIME=k8s`.
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly config: TriggerSchedulerConfig;
	readonly logger?: TickLogger;
	readonly now?: () => Date;
	/**
	 * Deployment-wide run-branch prefix fallback (warren-9993). Forwarded
	 * onto every scheduled `spawnRun` so cron/scheduled-for dispatches honor
	 * the same `WARREN_RUN_BRANCH_PREFIX` the HTTP `POST /runs` path uses.
	 */
	readonly runBranchPrefixDefault?: string;
	/**
	 * Boot-resolved forge (`ServerDeps.forge`, warren-0b49 — required,
	 * resolved ONCE at boot). Replaces the old captured `githubToken`:
	 *   - the CI-fixer poller reads check runs / log tails through it, and
	 *     its capability flags drive the §5 degradations;
	 *   - the self-heal re-clone and the scheduled-dispatch refresh mint
	 *     their git credential PER SPAWN via `mintGitCredential`
	 *     (forge-contract.md §4 — credentials are minted, never held), so a
	 *     short-lived App credential never has to outlive a tick loop.
	 */
	readonly forge: Forge;
	/**
	 * Boot-resolved IssueTracker (warren-5819), threaded onto every
	 * scheduled/ci-fixer `spawnRun` call. Tests may omit.
	 */
	readonly issueTracker?: import("../tracker/contract.ts").IssueTracker;
	/** Override the spawnRun seam (tests). Defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
	/**
	 * Filesystem probe for the self-heal clone check (warren-1ec7). Defaults
	 * to `existsSync`; tests inject a stub so a registered project's clone can
	 * be treated as present (or absent) without touching disk.
	 */
	readonly cloneExists?: (path: string) => boolean;
	/** Test override for setInterval (forwarded to `startScheduler`). */
	readonly setInterval?: (cb: () => void, ms: number) => SchedulerTimerHandle;
	readonly clearInterval?: (handle: SchedulerTimerHandle) => void;
}

/**
 * Construct the live scheduler with full production deps. The returned
 * handle goes on `WarrenServerHandle.stop`'s teardown chain.
 */
export function bootScheduler(input: BootSchedulerInput): SchedulerHandle {
	const spawnRunFn = input.spawnRunFn ?? spawnRun;

	const seedsDeps = { sdBinary: input.config.sdBinary, spawn: input.projectSpawn };
	// warren-5819: hoisted so the spawn closures below stay under the
	// cognitive-complexity ceiling.
	const trackerOption =
		input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {};

	// warren-a0a2: one bounded-retry tracker for the scheduler's process
	// lifetime (in-memory; a restart resets counters — see cron-retry.ts). The
	// cron dispatcher caps consecutive transient spawn failures per slot against
	// it, and GCs the transient never_started rows via `deleteNeverStarted`.
	const cronRetryTracker = new CronRetryTracker();
	const deleteNeverStartedRun = async (runId: string): Promise<void> => {
		await input.repos.runs.deleteNeverStarted(runId);
	};

	// warren-1ec7: self-heal + notice rate-limiting. One tracker for the
	// scheduler's process lifetime (in-memory; a restart resets backoff
	// counters — same shape as cronRetryTracker). The healer re-clones a
	// registered project whose on-disk clone vanished (ephemeral PVC), using
	// the same token/`insteadOf` auth as the dispatch clone (warren-57ad),
	// and the tracker gates the per-project error notices to once per hour.
	const projectHealTracker = new ProjectHealTracker();
	const ensureProjectClone = createProjectCloneHealer({
		tracker: projectHealTracker,
		config: input.projectsConfig,
		spawn: input.projectSpawn,
		mintCredential: (project) => mintGitCredential(input.forge, project.gitUrl),
		...(input.logger !== undefined ? { logger: input.logger } : {}),
		...(input.cloneExists !== undefined ? { exists: input.cloneExists } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
	});

	const mintProjectGitSecret = async (
		projectId: string,
	): Promise<GitSpawnCredential | undefined> => {
		// §4 per-spawn mint: credential is minted immediately before the spawn,
		// never captured at boot. Unowned URL / `no_credential` → undefined.
		const project = await input.repos.projects.get(projectId);
		return project !== null ? await mintGitCredential(input.forge, project.gitUrl) : undefined;
	};

	const spawnDispatch: DispatchSpawnFn = async (
		args: DispatchSpawnInput,
	): Promise<DispatchSpawnResult> => {
		const gitSecret = await mintProjectGitSecret(args.projectId);
		// warren-9ce3: origin from the resolved trigger kind; seedId forward
		// closes the scheduled-seed loss (was only buried in metadata).
		const dispatchOrigin = args.trigger === "scheduled" ? "scheduled" : "cron";
		const result = await spawnRunFn({
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			agentName: args.agentName,
			projectId: args.projectId,
			prompt: args.prompt,
			trigger: args.trigger,
			dispatchOrigin,
			...(args.seedId !== undefined ? { seedId: args.seedId } : {}),
			...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
			...(args.maxCostUsd !== undefined ? { maxCostUsdOverride: args.maxCostUsd } : {}),
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			gitCredential: gitSecret,
			warrenConfigs: input.warrenConfigs,
			seedsCli: seedsDeps,
			...trackerOption,
			// warren-a0a2: forward the cron dispatcher's row-id probe.
			...(args.onRowCreated !== undefined ? { onRunRowCreated: args.onRowCreated } : {}),
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		});
		// Same hand-off as POST /runs — bridge so events flow into warren.events.
		input.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id);
		return { runId: result.run.id };
	};

	// warren-0b75: CI-fixer dispatch wraps `spawnRun` like the cron path,
	// pinning trigger="ci-fixer" (the discriminator fixAttemptHistoryByPrUrl
	// counts) and back-linking the fixer to the PR's opener via parentRunId so
	// the fixer's workspace forks from the opener's pushed branch. warren-a993:
	// `targetBranch` pins the burrow branch to the PR head ref so the fixer's
	// commits push back onto the open PR (re-running its CI) instead of opening
	// a fresh `${prefix}/run_xxx` branch; reap honors the same branch on push.
	const ciFixerSpawn: TickCiFixerSpawnFn = async (
		args: TickCiFixerSpawnInput,
	): Promise<{ runId: string }> => {
		const gitSecret = await mintProjectGitSecret(args.projectId);
		const result = await spawnRunFn({
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			agentName: args.agentName,
			projectId: args.projectId,
			prompt: args.prompt,
			trigger: "ci-fixer",
			// warren-9ce3: underscore spelling matches the dispatch-origin
			// vocabulary (distinct from the hyphenated trigger column).
			dispatchOrigin: "ci_fixer",
			parentRunId: args.parentRunId,
			targetBranch: args.targetBranch,
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			gitCredential: gitSecret,
			warrenConfigs: input.warrenConfigs,
			seedsCli: seedsDeps,
			...trackerOption,
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		});
		input.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id);
		return { runId: result.run.id };
	};

	return startScheduler({
		tickMs: input.config.tickMs,
		disabled: input.config.disabled,
		repos: input.repos,
		loadWarrenConfig: (projectId, projectPath) => input.warrenConfigs.get(projectId, projectPath),
		// warren-6234: the scheduled-issues pass routes through the tracker
		// seam (listScheduledIssues + mergeIssueMetadata).
		...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
		spawn: spawnDispatch,
		cronRetryTracker,
		deleteNeverStartedRun,
		ensureProjectClone,
		noticeGate: projectHealTracker,
		ciFixer: {
			forge: input.forge,
			spawn: ciFixerSpawn,
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
		},
		...(input.logger !== undefined ? { logger: input.logger } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
		...(input.setInterval !== undefined ? { setInterval: input.setInterval } : {}),
		...(input.clearInterval !== undefined ? { clearInterval: input.clearInterval } : {}),
	});
}

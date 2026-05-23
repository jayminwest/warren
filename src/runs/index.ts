/**
 * Public re-exports for the run-spawn module. Internal modules import
 * from here so the file layout under `runs/` can shift without rippling
 * out to call sites.
 */

export {
	composeRunBranch,
	DEFAULT_RUN_BRANCH_PREFIX,
	loadRunBranchPrefixFromEnv,
	type RunBranchEnvLike,
	resolveRunBranchPrefix,
} from "./branch.ts";
export { type ParsedBurrowConfig, parseBurrowConfig } from "./burrow_config.ts";
export { type CancelRunInput, type CancelRunResult, cancelRun } from "./cancel.ts";
export { RunSpawnError } from "./errors.ts";
export {
	DEFAULT_SUBSCRIPTION_BUFFER,
	RunEventBroker,
	type SubscribeOptions,
	type TailRunEventsInput,
	tailRunEvents,
} from "./events.ts";
export {
	appendAgentMessage,
	appendUserMessage,
	buildInteractivePrompt,
	DEFAULT_PLOT_HISTORY_TAIL,
	defaultPlotContextReader,
	INTERACTIVE_AGENT_MESSAGE_KIND,
	INTERACTIVE_USER_MESSAGE_KIND,
	type InteractivePlotContext,
	type PlotContextReader,
	type SpawnInteractiveTurnInput,
	type SpawnInteractiveTurnResult,
	spawnInteractiveTurn,
} from "./interactive.ts";
export {
	type AutoOpenPrConfig,
	buildPrContent,
	loadAutoOpenPrConfigFromEnv,
	type OpenPullRequestInput,
	type OpenPullRequestResult,
	openPullRequest,
} from "./pr.ts";
export {
	mergeMulchFile,
	type ReapExec,
	type ReapFs,
	type ReapRunInput,
	type ReapRunResult,
	type ReapStep,
	type ReapStepError,
	reapRun,
} from "./reap.ts";
export {
	type BuildSeedFilesResult,
	buildSeedFiles,
	type HttpWorkspaceFile,
} from "./seed.ts";
export {
	DEFAULT_DISPATCHER_HANDLE,
	resolveDispatcherHandle,
	type SpawnRunInput,
	type SpawnRunResult,
	spawnRun,
} from "./spawn.ts";
export { type SteerRunInput, type SteerRunResult, steerRun } from "./steer.ts";
export {
	type ActiveBridge,
	type BridgeLogger,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	bridgeRunStream,
	type PiStatsClient,
	type RecoverActiveRunStreamsInput,
	type RecoverActiveRunStreamsResult,
	recoverActiveRunStreams,
	type SessionStats,
} from "./stream.ts";
export {
	accumulatePiUsage,
	aggregateUsageFromEvents,
	eventRowToUsageInput,
	extractClaudeUsage,
	newSessionStatsAccumulator,
	type SessionStatsAccumulator,
	type UsageEventInput,
} from "./usage-aggregate.ts";
export {
	hydrateRunsUsage,
	hydrateRunUsage,
	type UsageEventsFetcher,
} from "./usage-hydrate.ts";

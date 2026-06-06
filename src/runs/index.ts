/**
 * Public re-exports for the run-spawn module. Internal modules import
 * from here so the file layout under `runs/` can shift without rippling
 * out to call sites.
 */

export {
	buildCommandMining,
	type CategoryBucket,
	type CommandCategory,
	type CommandMining,
	type CommandMiningTotals,
	type CommandStat,
	categorize,
	generalizeCommand,
	isOsEcoCommand,
	type ToolEventRow,
} from "./analytics/command-mining.ts";
export {
	buildInsights,
	type Insight,
	type InsightKind,
	type InsightSeverity,
	type InsightsInput,
	type SteeringSignals,
} from "./analytics/insights.ts";
export {
	buildRunMetrics,
	contextTokensOf,
	type DimensionTokenSeries,
	durationMsOf,
	type FailureBucket,
	type GroupDimension as RunGroupDimension,
	NONE_KEY as RUN_METRICS_NONE_KEY,
	OTHER_KEY as RUN_METRICS_OTHER_KEY,
	type RunDayBucket,
	type RunGroupBucket,
	type RunMetrics,
	type RunMetricsRow,
	type RunTotals,
	type SeedContextBucket,
	type StatSummary,
	type TokenBreakdown,
	type TokenDayBucket,
} from "./analytics/run-metrics.ts";
export {
	composeRunBranch,
	DEFAULT_RUN_BRANCH_PREFIX,
	loadRunBranchPrefixFromEnv,
	type RunBranchEnvLike,
	resolveRunBranchPrefix,
} from "./branch.ts";
export { type ParsedBurrowConfig, parseBurrowConfig } from "./burrow-config.ts";
export { type CancelRunInput, type CancelRunResult, cancelRun } from "./cancel.ts";
export {
	type CreateMergePollerDispatchInput,
	createMergePollerDispatch,
} from "./conversation-merge-dispatch.ts";
export {
	type BootMergePollerInput,
	bootConversationMergePoller,
	buildPlannerDispatchPrompt,
	CONVERSATION_PLANNER_DISPATCHED_KIND,
	DEFAULT_PLANNER_AGENT,
	type MergePollerHandle,
	type MergePollTickDeps,
	type MergePollTickResult,
	type PlannerDispatchFn,
	type PlannerDispatchInput,
	type PlannerDispatchResult,
	tickConversationMergePoller,
} from "./conversation-merge-poller.ts";
export {
	buildCostAnalytics,
	type CostAnalytics,
	type CostAnalyticsRow,
	type CostBucket,
	type Dimension as CostDimension,
	NONE_KEY as COST_ANALYTICS_NONE_KEY,
} from "./cost-analytics.ts";
export { RunSpawnError } from "./errors.ts";
export {
	DEFAULT_SUBSCRIPTION_BUFFER,
	RunEventBroker,
	type SubscribeOptions,
	type TailRunEventsInput,
	tailRunEvents,
} from "./events.ts";
export {
	bootPauseDetector,
	defaultPlotEventReader,
	extractAnswerText,
	findAnswerFor,
	PAUSE_DETECTED_KIND,
	PAUSE_RESUMED_KIND,
	PAUSE_TIMED_OUT_KIND,
	type PauseDetectorHandle,
	type PauseTickDeps,
	type PauseTickResult,
	type PlotEventReader,
	pickUnansweredQuestion,
	type RespawnFn,
	type RespawnInput,
	type RespawnReason,
	tickPauseDetector,
} from "./pause.ts";
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
} from "./reap/index.ts";
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
} from "./spawn/index.ts";
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
} from "./stream/index.ts";
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
export {
	type BootWatchdogInput,
	bootWatchdog,
	computeIdleMs,
	DEFAULT_WATCHDOG_TICK_MS,
	loadWatchdogConfigFromEnv,
	tickWatchdog,
	WATCHDOG_TIMED_OUT_KIND,
	type WatchdogConfig,
	type WatchdogHandle,
	type WatchdogTickDeps,
	type WatchdogTickResult,
} from "./watchdog.ts";

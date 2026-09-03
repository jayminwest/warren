/**
 * Public re-exports for the run-spawn module. Internal modules import
 * from here so the file layout under `runs/` can shift without rippling
 * out to call sites.
 */

// Row type re-export at the domain seam (warren-02c9): the drizzle schema
// stays the source of the inferred type; handlers import `RunRow` from here.
export type { EventRow, RunRow } from "../db/schema.ts";
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
	type RuntimeCommandCoverage,
	type ToolCallMiningRow,
} from "./analytics/command-mining.ts";
export {
	buildContextWaste,
	type ContextWasteProxy,
	type ContextWasteShare,
} from "./analytics/context-waste.ts";
export {
	buildDirectoryDifficulty,
	DEFAULT_DIRECTORY_LIMIT,
	type DirectoryDifficulty,
	type DirectoryDifficultyTotals,
	type DirectoryRunOutcome,
	type DirectoryStat,
	type DirectoryToolCallRow,
	MIN_DIRECTORY_RUNS,
	normalizeDirectory,
} from "./analytics/directory-difficulty.ts";
export {
	buildDispatchAnalytics,
	type DispatchAnalytics,
	type DispatchAnalyticsRow,
	type DispatchCountBucket,
	NONE_KEY as DISPATCH_ANALYTICS_NONE_KEY,
} from "./analytics/dispatch-analytics.ts";
export {
	buildInsights,
	buildSteeringSignals,
	countSteeringByRun,
	type Insight,
	type InsightConfidence,
	type InsightKind,
	type InsightSeverity,
	type InsightsInput,
	type SteeringEventRow,
	type SteeringSignals,
} from "./analytics/insights.ts";
export {
	buildCostPerMergedPr,
	buildRunOutcomes,
	buildSteeringOutcomeComparison,
	type CostPerMergedPr,
	type CostPerMergedPrBucket,
	confidenceForSample,
	type OutcomeTally,
	type RunOutcomes,
	type SteeringOutcomeComparison,
	type SteeringOutcomeEventRow,
} from "./analytics/outcome-analytics.ts";
export {
	buildRunMetrics,
	contextTokensOf,
	type DimensionTokenSeries,
	durationMsOf,
	type FailureBucket,
	type GroupDimension as RunGroupDimension,
	NONE_KEY as RUN_METRICS_NONE_KEY,
	OTHER_KEY as RUN_METRICS_OTHER_KEY,
	queueWaitMsOf,
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
	extractToolResult,
	extractToolUse,
	runtimeFromRenderedAgent,
	type ToolResultExtraction,
	type ToolUseExtraction,
} from "./analytics/tool-call-extract.ts";
export {
	composeRunBranch,
	DEFAULT_RUN_BRANCH_PREFIX,
	loadRunBranchPrefixFromEnv,
	type RunBranchEnvLike,
	resolveRunBranchPrefix,
} from "./branch.ts";
export { type ParsedBurrowConfig, parseBurrowConfig } from "./burrow-config.ts";
export { type CancelReap, type CancelRunInput, type CancelRunResult, cancelRun } from "./cancel.ts";
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
	type PollRunInboxInput,
	type PollRunInboxResult,
	pollRunInbox,
} from "./inbox.ts";
export {
	type BranchPushedPayload,
	clearLifecycleBus,
	type EventEmittedPayload,
	installLifecycleBus,
	LIFECYCLE_HOOKS,
	LifecycleBus,
	type LifecycleBusOptions,
	type LifecycleEnvelope,
	type LifecycleErrorSink,
	type LifecycleExtension,
	type LifecycleHandler,
	type LifecycleHook,
	type LifecycleOutcome,
	type LifecyclePayloads,
	type LifecycleRegistration,
	lifecycleBus,
	type PostReapPayload,
	type PreReapPayload,
	type RunDispatchedPayload,
	type RunStartedPayload,
	registerExtensions,
	WARREN_EXT_PROTOCOL,
	type WarrenExtProtocol,
} from "./lifecycle-bus.ts";
export {
	createLifecycleStreamExtension,
	DEFAULT_LIFECYCLE_STREAM_BUFFER,
	LifecycleStreamBroker,
	type LifecycleStreamNotification,
	type LifecycleStreamSubscribeOptions,
} from "./lifecycle-stream.ts";
export {
	type AutoOpenPrConfig,
	buildPrContent,
	loadAutoOpenPrConfigFromEnv,
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
	type CreateInfraLostRetryHookInput,
	createInfraLostRetryHook,
	decideInfraLostRetry,
	INFRA_LOST_RUN_FAILURE_REASONS,
	type InfraLostRetryDecision,
	type InfraLostRetryHook,
	type InfraLostRetrySkip,
	type InfraLostRunFailureReason,
	isInfraLostRunFailure,
	RUN_RETRY_DISPATCHED_KIND,
	RUN_RETRY_OF_KIND,
} from "./retry/infra-lost-retry.ts";
export {
	classifyProviderError,
	createProviderRetryLifecycleExtension,
	PROVIDER_RETRY_EVENTS,
	type ProviderErrorClass,
	type ProviderRetryLifecycleExtensionInput,
	type ProviderRetryLogger,
} from "./retry/provider-retry.ts";
export {
	type BuildSeedFilesResult,
	buildSeedFiles,
	type SeedFile,
} from "./seed.ts";
export {
	DISPATCH_ORIGINS,
	type DispatchOrigin,
	type SpawnRunInput,
	type SpawnRunResult,
	spawnRun,
} from "./spawn/index.ts";
export { type SteerRunInput, type SteerRunResult, steerRun } from "./steer.ts";
export {
	type ActiveBridge,
	type BoundBridgeLogger,
	type BridgeLogger,
	type BridgeLoggerBindings,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	bindBridgeLogger,
	bridgeRunStream,
	NOOP_BRIDGE_LOGGER,
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
	tickWatchdog,
	WATCHDOG_TIMED_OUT_KIND,
	type WatchdogHandle,
	type WatchdogReap,
	type WatchdogTickDeps,
	type WatchdogTickResult,
} from "./watchdog.ts";
export {
	loadWatchdogConfigFromEnv,
	type WatchdogConfig,
} from "./watchdog-config.ts";

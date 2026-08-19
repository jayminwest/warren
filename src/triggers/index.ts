/**
 * Public re-exports for the R-06 scheduler module. Internal modules
 * import from here so file layout under `triggers/` can shift without
 * rippling out to call sites (mirrors src/warren-config/ + src/runs/).
 *
 * Seeds CLI shell-out (listScheduledSeeds, clearScheduledFor, envelope
 * schema, SeedsCliError) lives in `src/seeds-cli/` — consumers import
 * from there directly.
 */

export {
	DEFAULT_SCHEDULER_TICK_MS,
	DEFAULT_SD_BINARY,
	type EnvLike,
	loadTriggerSchedulerConfigFromEnv,
	type TriggerSchedulerConfig,
} from "./config.ts";
export {
	DEFAULT_TIMEZONE,
	type ParseCronInput,
	type ParseCronResult,
	type ParsedCron,
	parseCron,
} from "./cron.ts";
export {
	type CronRetryState,
	CronRetryTracker,
	MAX_CRON_TRANSIENT_RETRIES,
} from "./cron-retry.ts";
export {
	type DispatchCronInput,
	type DispatchCronResult,
	type DispatchScheduledInput,
	type DispatchScheduledResult,
	type DispatchSpawnFn,
	type DispatchSpawnInput,
	type DispatchSpawnResult,
	dispatchCronTrigger,
	dispatchScheduledSeed,
	resolveCronPrompt,
} from "./dispatch.ts";
export { TriggerDispatchError } from "./errors.ts";
export {
	createProjectCloneHealer,
	type EnsureProjectCloneFn,
	type HealLogger,
	NOTICE_INTERVAL_MS,
	type ProjectCloneHealerInput,
	type ProjectCloneHealResult,
	ProjectHealTracker,
	RECLONE_BACKOFF_BASE_MS,
	RECLONE_BACKOFF_MAX_MS,
	type RecloneMissingProjectInput,
	recloneMissingProject,
} from "./project-heal.ts";
export {
	type RecordFireInput,
	type TriggerKey,
	TriggersRepo,
	type UpsertTriggerInput,
} from "./repo.ts";
export {
	type BuildTriggerSummariesInput,
	buildTriggerSummaries,
	type TriggerSummary,
} from "./summary.ts";
export {
	type LoadWarrenConfigFn,
	type RunTickResult,
	runTick,
	type SchedulerHandle,
	type SchedulerNoticeGate,
	type SchedulerTimerHandle,
	type StartSchedulerInput,
	startScheduler,
	type TickCiFixerDeps,
	type TickCiFixerSpawnFn,
	type TickCiFixerSpawnInput,
	type TickDeps,
	type TickLogger,
} from "./tick.ts";

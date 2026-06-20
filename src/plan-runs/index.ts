/**
 * Public re-exports for the PlanRun coordinator (pl-a258 step 5 /
 * warren-2623). Internal modules import from here so the file layout under
 * `plan-runs/` can shift without rippling out to call sites (mirrors
 * src/triggers/ and src/runs/).
 */

export {
	DEFAULT_PLAN_RUN_MERGE_TIMEOUT_MS,
	DEFAULT_PLAN_RUN_TICK_MS,
	type EnvLike,
	loadPlanRunCoordinatorConfigFromEnv,
	type PlanRunCoordinatorConfig,
} from "./config.ts";
export {
	type AdvancePlanRunInput,
	type AdvanceResult,
	advancePlanRun,
	type CoordinatorEmitFn,
	type CoordinatorReopenPrFn,
	type CoordinatorRepos,
	type CoordinatorShowSeedFn,
	type CoordinatorSpawnFn,
	type CoordinatorSpawnInput,
	type CoordinatorSpawnResult,
	type CoordinatorTransitionPlotFn,
	DEFAULT_MERGE_TIMEOUT_MS,
	isChildTerminal,
	PLAN_RUN_EVENT_KINDS,
	type PlanRunEventKind,
} from "./coordinator.ts";
export {
	type CreatePlanRunSpawnInput,
	createPlanRunSpawn,
	createResolveExecution,
	resolveChildExecution,
} from "./dispatch.ts";
export {
	PlanHasNoOpenChildrenError,
	PlanRunDispatchError,
	ProjectLacksPlotError,
	ProjectLacksSeedsError,
} from "./errors.ts";
export {
	type AppendPlanRunDispatchedInput,
	defaultPlanRunPlotAppender,
	type EmitPlanRunDispatchedInput,
	emitPlanRunDispatchedToPlot,
	type PlanRunPlotAppender,
} from "./plot-appender.ts";
export {
	type AutoTransitionPlotToDoneInput,
	type AutoTransitionResult,
	autoTransitionPlotToDone,
	defaultPlotStatusSetter,
	type PlotStatusSetter,
	type SetPlotStatusToDoneInput,
} from "./plot-transition.ts";
export {
	type CreatePrMergeCheckerInput,
	createPrMergeChecker,
	type PrMergeChecker,
} from "./pr-merge.ts";
export {
	type BootPlanRunCoordinatorInput,
	bootPlanRunCoordinator,
	type PlanRunAdvanceLog,
	type PlanRunCoordinatorHandle,
	type PlanRunCoordinatorTimerHandle,
	type PlanRunTickDeps,
	type PlanRunTickLogger,
	type PlanRunTickResult,
	runPlanRunTick,
} from "./tick.ts";

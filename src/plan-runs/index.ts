/**
 * Public re-exports for the PlanRun coordinator (pl-a258 step 5 /
 * warren-2623). Internal modules import from here so the file layout under
 * `plan-runs/` can shift without rippling out to call sites (mirrors
 * src/triggers/ and src/runs/).
 */

export {
	assertPlanRunPromptTemplate,
	DEFAULT_PLAN_RUN_PROMPT_TEMPLATE,
	hasSeedIdPlaceholder,
	renderPlanRunPrompt,
	SEED_ID_PLACEHOLDER,
} from "../core/plan-run-prompt.ts";
// Row type re-exports at the domain seam (warren-02c9): the drizzle schema
// stays the source of the inferred types; handlers import them from here.
export type { PlanRunChildRow, PlanRunRow } from "../db/schema.ts";
export {
	type CreatePrMergeCheckerInput,
	createPrMergeChecker,
	type PrMergeChecker,
} from "../runs/pr-merge.ts";
export {
	type CancelPlanRunInput,
	type CancelPlanRunLogger,
	type CancelPlanRunResult,
	cancelPlanRun,
} from "./cancel.ts";
export {
	type CloseMergedChildSeedInput,
	type CloseMergedChildSeedResult,
	closeMergedChildSeed,
} from "./close-child-seed.ts";
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
	type CoordinatorCloseChildSeedFn,
	type CoordinatorEmitFn,
	type CoordinatorGetIssueFn,
	type CoordinatorReopenPrFn,
	type CoordinatorRepos,
	type CoordinatorSpawnFn,
	type CoordinatorSpawnInput,
	type CoordinatorSpawnResult,
	DEFAULT_MERGE_TIMEOUT_MS,
	PLAN_RUN_EVENT_KINDS,
	type PlanRunEventKind,
} from "./coordinator.ts";
export {
	type CreatePlanRunOrchestrationInput,
	createPlanRun,
	PLAN_RUN_ACCEPTED_PLAN_STATUSES,
} from "./create.ts";
export { type CreatePlanRunSpawnInput, createPlanRunSpawn } from "./dispatch.ts";
export { PlanHasNoOpenChildrenError, ProjectLacksTrackerError } from "./errors.ts";
export {
	type ComputeReadyPlansInput,
	computeReadyPlans,
	type ReadyPlan,
	type ReadyPlanInput,
} from "./ready-plans.ts";
export {
	isResumablePlanRunFailure,
	RESUMABLE_PLAN_RUN_FAILURE_REASONS,
	type ResumablePlanRunFailureReason,
	type ResumePlanRunInput,
	type ResumePlanRunResult,
	resumePlanRun,
} from "./resume.ts";
export {
	hasChildRetryBudget,
	isRetryableChildFailure,
	MAX_CHILD_RETRIES,
	RETRYABLE_CHILD_FAILURE_REASONS,
	type RetryableChildFailureReason,
	shouldRetryChild,
} from "./retry.ts";
export {
	type PlanRunEventRow,
	type TailPlanRunEventsInput,
	tailPlanRunEvents,
} from "./tail-events.ts";
export {
	type BootPlanRunCoordinatorInput,
	bootPlanRunCoordinator,
	buildDefaultPlanRunEmit,
	type PlanRunAdvanceLog,
	type PlanRunCoordinatorHandle,
	type PlanRunCoordinatorTimerHandle,
	type PlanRunTickDeps,
	type PlanRunTickLogger,
	type PlanRunTickResult,
	runPlanRunTick,
} from "./tick.ts";

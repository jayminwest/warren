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
	type CoordinatorReopenPrFn,
	type CoordinatorRepos,
	type CoordinatorShowSeedFn,
	type CoordinatorSpawnFn,
	type CoordinatorSpawnInput,
	type CoordinatorSpawnResult,
	DEFAULT_MERGE_TIMEOUT_MS,
	PLAN_RUN_EVENT_KINDS,
	type PlanRunEventKind,
} from "./coordinator.ts";
export { type CreatePlanRunSpawnInput, createPlanRunSpawn } from "./dispatch.ts";
export { PlanHasNoOpenChildrenError, ProjectLacksSeedsError } from "./errors.ts";
export {
	type CreatePrMergeCheckerInput,
	createPrMergeChecker,
	type PrMergeChecker,
} from "./pr-merge.ts";
export {
	type ComputeReadyPlansInput,
	computeReadyPlans,
	type ReadyPlan,
	type ReadyPlanInput,
} from "./ready-plans.ts";
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

/**
 * Public re-exports for the seeds CLI facade. Consumers import from
 * here so the file layout under `seeds-cli/` can shift without
 * rippling out to call sites (mirrors src/warren-config/ + src/runs/).
 *
 * The facade owns:
 *   - the seeds `sd list` / `sd update --extensions` envelope schema
 *   - `listScheduledSeeds` / `clearScheduledFor` operations used by the
 *     R-06 cron tick
 *   - `updateExtensions` + the warren-namespaced extensions schema
 *     (R-01 producer side, pl-bb70 step 2)
 */

export { SeedNotFoundError, SeedsCliError } from "./errors.ts";
export {
	clearScheduledFor,
	closeSeed,
	listScheduledSeeds,
	type SeedsCliDeps,
	updateExtensions,
} from "./extensions.ts";
export { listSeedStatuses } from "./list.ts";
export {
	type ParseScheduledSeedsResult,
	type PlanListEnvelope,
	PlanListEnvelopeSchema,
	type PlanShowEnvelope,
	PlanShowEnvelopeSchema,
	type PlanShowPlan,
	type PlanShowStep,
	type PlanSummary,
	parseScheduledSeeds,
	type ScheduledSeed,
	type SeedRow,
	type SeedShowEnvelope,
	SeedShowEnvelopeSchema,
	type SeedShowIssue,
	type SeedsListEnvelope,
	SeedsListEnvelopeSchema,
} from "./schema.ts";
export {
	listPlans,
	type PlanShowResult,
	type SeedShowResult,
	showPlan,
	showSeed,
} from "./show.ts";
export {
	readTargetRepo,
	type WarrenExtensions,
	WarrenExtensionsSchema,
	WarrenTriggerKind,
} from "./warren-extensions.ts";

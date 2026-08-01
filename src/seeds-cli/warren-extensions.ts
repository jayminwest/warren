/**
 * The warren-owned namespace inside seeds `extensions`.
 *
 * Seeds keeps `Issue.extensions` schema-stable on purpose — consumers
 * (warren, greenhouse, overstory) validate their own keys. Warren writes
 * a small, fixed set of pointer-style fields back to a seed after a
 * dispatch so the issues UI (R-04) can render "what ran where, last":
 *
 *   - `role`             the agent the run was dispatched against
 *   - `trigger`          how the run was kicked off (zod enum, see below)
 *   - `lastRunId`        warren-side run id of the most recent dispatch
 *   - `lastRunAt`        ISO 8601 timestamp the dispatch was created
 *   - `scheduledFor`     ISO 8601, set by operators / cleared (null) by warren
 *   - `lastScheduledRun` warren-side run id of the most recent scheduled fire
 *
 * Acceptance criteria for the R-01 producer side (pl-bb70):
 *   - manual POST /runs → `{role, trigger:'manual', lastRunId, lastRunAt}`
 *   - cron tick       → `{scheduledFor:null, lastScheduledRun, lastRunId,
 *                          lastRunAt, role, trigger:'cron'}` in one write
 *
 * `WarrenTriggerKind` locks down the trigger-string proliferation called
 * out as risk #6 in the plan. Today the cron-trigger manual-run handler
 * `src/server/handlers/projects.ts` (POST /projects/:id/triggers/:triggerId/run)
 * writes `"manual-trigger"` into the warren `runs.trigger` column, while
 * Run Now (POST /runs) passes no trigger and defaults to `"manual"`; the
 * enum here is the downstream-stable contract that step 4 will reconcile
 * callers onto.
 *
 * The schema is `.strict()` for writes — unknown keys would silently
 * persist into seeds and rot the convention. Reads go through
 * `schema.ts` which is intentionally permissive (`.passthrough()`).
 */

import { z } from "zod";

export const WarrenTriggerKind = z.enum([
	"manual",
	"cron",
	"scheduled",
	"webhook",
	"comment",
	"cli",
]);
export type WarrenTriggerKind = z.infer<typeof WarrenTriggerKind>;

const IsoTimestamp = z.string().min(1, "must be a non-empty ISO 8601 string");

/**
 * Schema for the warren-namespaced subset of `Issue.extensions`. Every
 * field is optional so partial updates work — seeds applies shallow merge
 * on `sd update --extensions`, and `null` is the seeds-side clear signal
 * (only `scheduledFor` / `lastScheduledRun` are nullable today; other
 * keys are append-only via warren's dispatch path).
 */
export const WarrenExtensionsSchema = z
	.object({
		role: z.string().min(1).optional(),
		trigger: WarrenTriggerKind.optional(),
		lastRunId: z.string().min(1).optional(),
		lastRunAt: IsoTimestamp.optional(),
		scheduledFor: IsoTimestamp.nullable().optional(),
		lastScheduledRun: z.string().min(1).nullable().optional(),
	})
	.strict();
export type WarrenExtensions = z.infer<typeof WarrenExtensionsSchema>;

/**
 * Zod schemas for the seeds CLI JSON envelopes warren consumes.
 *
 * Two pieces matter today:
 *   1. `sd list --format json` — pull every issue with extensions, used
 *      by the scheduler to filter down to seeds carrying a parseable
 *      `scheduledFor` in the past.
 *   2. `sd update <id> --extensions <json>` returns a similar issue row;
 *      we don't read the response payload today, but the schema lives here
 *      so the same parser handles both shapes when we do.
 *
 * Schemas are intentionally permissive: seeds adds extensions fields
 * regularly (plan-backrefs, scheduledFor, lastScheduledRun, …) and the
 * facade should not break when seeds ships a new one. We parse only the
 * fields warren needs and pass `.passthrough()` everywhere else.
 *
 * `scheduledFor` is canonical ISO 8601; we parse to a `Date` in
 * `parseScheduledSeeds` rather than carrying string-typed timestamps
 * through the scheduler.
 */

import { z } from "zod";

const IsoDateString = z.string().min(1, "scheduledFor must be a non-empty ISO 8601 string");

const SeedExtensionsSchema = z
	.object({
		// `null` is the post-fire state (sd update --extensions writes null to
		// clear). Treat null + undefined as "not scheduled" so the filter is
		// `scheduledFor === string`.
		scheduledFor: IsoDateString.nullish(),
		lastScheduledRun: z.string().nullish(),
	})
	.passthrough();

const SeedRowSchema = z
	.object({
		id: z.string().min(1),
		status: z.string().min(1),
		title: z.string().optional(),
		extensions: SeedExtensionsSchema.optional(),
	})
	.passthrough();

export const SeedsListEnvelopeSchema = z
	.object({
		success: z.boolean().optional(),
		issues: z.array(SeedRowSchema),
	})
	.passthrough();

export type SeedRow = z.infer<typeof SeedRowSchema>;
export type SeedsListEnvelope = z.infer<typeof SeedsListEnvelopeSchema>;

/**
 * Envelope shape for `sd plan show <id> --json`. We parse only the fields
 * warren needs (plan id/status/children + the step blocks-DAG used at create
 * time to enumerate child seeds in order) and pass `.passthrough()`
 * everywhere else so seeds can grow new fields without breaking the facade.
 */
// `title` is optional because `sd plan submit` (seeds-cli 0.4.7+)
// accepts adoption-only steps that carry `existing_seed` and omit
// `title` (warren-d519). `sd plan show --json` persists these steps
// as `{existing_seed: "<id>"}` with no title field — the adopted
// seed's title is surfaced separately via the envelope's `children[]`
// detail rows. The plot-plan-run synthesis path (SPEC §11.Q) reads
// `plan.children` for dispatch and ignores `steps[]`, so accepting
// the optional shape lets `showPlan` parse synthesized plans without
// the facade getting in the way.
const PlanShowStepSchema = z
	.object({
		title: z.string().optional(),
		existing_seed: z.string().optional(),
		blocks: z.array(z.number().int().nonnegative()).optional(),
	})
	.passthrough();

const PlanShowSectionsSchema = z
	.object({
		steps: z.array(PlanShowStepSchema).optional(),
	})
	.passthrough();

const PlanShowPlanSchema = z
	.object({
		id: z.string().min(1),
		status: z.string().min(1),
		children: z.array(z.string().min(1)),
		sections: PlanShowSectionsSchema.optional(),
	})
	.passthrough();

export const PlanShowEnvelopeSchema = z
	.object({
		success: z.boolean().optional(),
		plan: PlanShowPlanSchema,
	})
	.passthrough();

export type PlanShowEnvelope = z.infer<typeof PlanShowEnvelopeSchema>;
export type PlanShowStep = z.infer<typeof PlanShowStepSchema>;
export type PlanShowPlan = z.infer<typeof PlanShowPlanSchema>;

/**
 * Envelope shape for `sd show <id> --json`. The coordinator branches on
 * `status` (only `'closed'` triggers the skip-on-resume path); other
 * callers may read `blockedBy` to detect partially-resolved dependencies.
 * `extensions` is left as an unknown record so it can be threaded through
 * to typed downstream parsers (e.g. WarrenExtensionsSchema) without this
 * envelope locking the shape.
 */
const SeedShowIssueSchema = z
	.object({
		id: z.string().min(1),
		status: z.string().min(1),
		blockedBy: z.array(z.string().min(1)).optional(),
		extensions: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

export const SeedShowEnvelopeSchema = z
	.object({
		success: z.boolean().optional(),
		issue: SeedShowIssueSchema,
	})
	.passthrough();

export type SeedShowEnvelope = z.infer<typeof SeedShowEnvelopeSchema>;
export type SeedShowIssue = z.infer<typeof SeedShowIssueSchema>;

/**
 * Envelope shape for `sd plan list --json` (warren-9b49 / pl-dfb5 step 3).
 * Used by the read endpoint that populates the plan-run dispatch form's
 * plan-id selector. We parse only the lean metadata the selector needs
 * (id/name/status/seed/template + timestamps + child count) and drop the
 * heavyweight `sections` payload `sd plan list` emits for every plan —
 * the form only renders a label, not the plan body. `.passthrough()` keeps
 * the facade forward-compatible as seeds grows new fields.
 */
const PlanListPlanSchema = z
	.object({
		id: z.string().min(1),
		seed: z.string().min(1).optional(),
		template: z.string().optional(),
		status: z.string().min(1),
		revision: z.number().int().optional(),
		name: z.string().optional(),
		children: z.array(z.string().min(1)).optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	})
	.passthrough();

export const PlanListEnvelopeSchema = z
	.object({
		success: z.boolean().optional(),
		plans: z.array(PlanListPlanSchema),
	})
	.passthrough();

export type PlanListEnvelope = z.infer<typeof PlanListEnvelopeSchema>;

/**
 * Projected, wire-lean plan summary returned by `listPlans` — strips the
 * `sd plan list` `sections` blob and any other passthrough fields so the
 * HTTP response stays small.
 */
export interface PlanSummary {
	readonly id: string;
	readonly status: string;
	readonly seed?: string;
	readonly template?: string;
	readonly revision?: number;
	readonly name?: string;
	readonly childCount: number;
	readonly createdAt?: string;
	readonly updatedAt?: string;
}

export interface ScheduledSeed {
	readonly id: string;
	readonly status: string;
	readonly title?: string;
	readonly scheduledFor: Date;
}

export interface ParseScheduledSeedsResult {
	/** Open seeds with a parseable scheduledFor extension, regardless of past/future. */
	readonly scheduled: readonly ScheduledSeed[];
	/** Per-seed parse failures (bad ISO date, etc.). Surface as warnings. */
	readonly errors: readonly { readonly seedId: string; readonly message: string }[];
}

/**
 * Filter the parsed envelope down to open seeds carrying a scheduledFor
 * extension. Closed seeds are dropped — dispatching against a finished
 * issue is a no-op. The caller decides which entries are due (`<= now`)
 * versus future.
 */
export function parseScheduledSeeds(envelope: SeedsListEnvelope): ParseScheduledSeedsResult {
	const scheduled: ScheduledSeed[] = [];
	const errors: { seedId: string; message: string }[] = [];

	for (const row of envelope.issues) {
		const raw = row.extensions?.scheduledFor;
		if (raw === null || raw === undefined) continue;
		if (row.status === "closed") continue;

		const parsed = parseIsoDate(raw);
		if (parsed === null) {
			errors.push({
				seedId: row.id,
				message: `scheduledFor is not a parseable ISO 8601 timestamp: "${raw}"`,
			});
			continue;
		}
		const entry: ScheduledSeed = {
			id: row.id,
			status: row.status,
			scheduledFor: parsed,
			...(row.title !== undefined ? { title: row.title } : {}),
		};
		scheduled.push(entry);
	}

	return { scheduled, errors };
}

function parseIsoDate(raw: string): Date | null {
	const ms = Date.parse(raw);
	if (Number.isNaN(ms)) return null;
	return new Date(ms);
}

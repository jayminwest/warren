/**
 * Analytics insight vocabulary (warren-be04 / pl-103e step 12), split out of
 * wire.ts under the file-size budget (the same move as ./wire-inbox.ts) and
 * re-exported from there so the canonical home stays one module.
 */

/**
 * Confidence qualifier for derived analytics callouts (warren-be04 /
 * pl-103e step 12). Every outcome-joined insight number ships with one:
 * `high` over a meaningful sample, `medium` over a usable one, `low`
 * otherwise. Canonical here because the UI (warren-25b7) renders the
 * qualifier badge and must not keep its own copy of the vocabulary.
 */
export const INSIGHT_CONFIDENCES = ["low", "medium", "high"] as const;
export type InsightConfidence = (typeof INSIGHT_CONFIDENCES)[number];

/** Membership predicate for {@link INSIGHT_CONFIDENCES}. */
export function isInsightConfidence(value: unknown): value is InsightConfidence {
	return typeof value === "string" && (INSIGHT_CONFIDENCES as readonly string[]).includes(value);
}

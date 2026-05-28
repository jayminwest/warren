/**
 * Pure helpers shared across the PlotDetail sub-components. Extracted
 * so substrate-panel.tsx (which consumes `isSdPlanAttachment` /
 * `isBatchDispatchTarget`) and batch-dispatch.tsx (which also consumes
 * `isSdPlanAttachment`) avoid a circular import, and so
 * activity-feed.tsx and interactive-panel.tsx share the same narrow
 * `readString` type guard for unknown event payloads.
 *
 * No React, no DOM, no API client deps — keep it that way.
 */

import type { PlotAttachment } from "@/api/types.ts";

/**
 * Narrow a value to `string | null`. Used when reading fields out of
 * `PlotEvent.data` (whose shape is `Record<string, unknown>` by
 * design) so the renderers don't have to repeat the `typeof x ===
 * "string"` check at every call site.
 */
export function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

/**
 * An sd_plan attachment is a `seeds_issue` whose ref starts with
 * `pl-`. plot-cli v0.3 has no dedicated 'sd_plan' AttachmentType yet;
 * tighten this predicate when it does.
 */
export function isSdPlanAttachment(a: PlotAttachment): boolean {
	return a.type === "seeds_issue" && /^pl-/i.test(a.ref);
}

/**
 * A batch-dispatch target is a plain `seeds_issue` (NOT an sd_plan) —
 * the "Dispatch all" button fans those out to individual runs.
 */
export function isBatchDispatchTarget(a: PlotAttachment): boolean {
	return a.type === "seeds_issue" && !isSdPlanAttachment(a);
}

/**
 * Public-projection classification for the `contextWaste` section of
 * `GET /analytics/behavior` (warren-6d41 / pl-103e step 11), split out of
 * `./analytics.ts` under the file-size budget.
 *
 * `/analytics/behavior` — the only surface the section ships on — is
 * `readOperator`, so today EVERY field is operator-only: the per-tool and
 * per-command keys are internal tooling detail (the same call that keeps
 * the whole `mining` section off the public surface), and the byte/token
 * totals ride along. The lists exist as data so a future `readPublic`
 * behavior projection must re-classify deliberately, and so the
 * classification test in `public-projections.test.ts` fails the build if
 * a new wire field lands unclassified.
 */

import type { ContextWasteProxy, ContextWasteShare } from "../../../runs/index.ts";

/** No `ContextWasteProxy` field is spectator-visible today. */
export const PUBLIC_CONTEXT_WASTE_FIELDS =
	[] as const satisfies readonly (keyof ContextWasteProxy)[];

/** Every `ContextWasteProxy` field, operator-only. */
export const REDACTED_CONTEXT_WASTE_FIELDS = [
	"runsInWindow",
	"runsWithRollup",
	"runsMeasured",
	"contextTokensTotal",
	"resultBytesTotal",
	"share",
	"byTool",
	"byCommand",
	"confidence",
] as const satisfies readonly (keyof ContextWasteProxy)[];

/** No `ContextWasteShare` field is spectator-visible today. */
export const PUBLIC_CONTEXT_WASTE_SHARE_FIELDS =
	[] as const satisfies readonly (keyof ContextWasteShare)[];

/** Every `ContextWasteShare` field, operator-only. */
export const REDACTED_CONTEXT_WASTE_SHARE_FIELDS = [
	"key",
	"invocations",
	"resultBytesKnown",
	"resultBytesTotal",
	"runs",
	"runsMeasured",
	"contextTokensTotal",
	"share",
] as const satisfies readonly (keyof ContextWasteShare)[];

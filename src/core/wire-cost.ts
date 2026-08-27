/**
 * Cost-basis vocabulary (warren-f3c3 / pl-26f3 step 5), split out of
 * `wire.ts` for file-size budget. Re-exported by `src/core/wire.ts` so the
 * canonical import path stays `src/core/wire.ts`.
 */

export const RUN_COST_BASES = ["api", "subscription_estimate"] as const;
export type RunCostBasis = (typeof RUN_COST_BASES)[number];

/**
 * How a run's `costUsd` number was priced. `api` — priced at API rates
 * against an `ANTHROPIC_API_KEY`-class credential (a bill).
 * `subscription_estimate` — the run authenticated through a subscription
 * credential (`CLAUDE_CODE_OAUTH_TOKEN`), so `costUsd` is an API-priced
 * ESTIMATE of what the same usage would have cost, not money owed. Fixed
 * at run-create time from the dispatch-env credential shape
 * (`resolveRunCostBasis` in `src/core/providers.ts`); legacy rows read
 * `api`.
 */

/** Narrow an unknown value to a {@link RunCostBasis}. */
export function isRunCostBasis(value: unknown): value is RunCostBasis {
	return typeof value === "string" && (RUN_COST_BASES as readonly string[]).includes(value);
}

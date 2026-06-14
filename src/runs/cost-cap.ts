/**
 * Spend-cap resolution + evaluation (warren-a63d).
 *
 * Warren historically tracked cost post-hoc only (`runs.cost_usd`) with
 * no enforcement anywhere — a runaway cron patrol (especially a
 * Fable-tier agent) had no ceiling. This module is the shared, pure core
 * of the per-agent / per-trigger spend cap:
 *
 *   - per-agent cap   — `frontmatter.maxCostUsd` on the canopy agent
 *                       definition (frozen onto `runs.rendered_agent_json`).
 *   - per-trigger cap — `maxCostUsd` on a `.warren/triggers.yaml` cron
 *                       entry. Dispatch folds it onto the agent
 *                       frontmatter as an override BEFORE freezing the
 *                       run row, so the per-trigger value wins over the
 *                       agent's own (trigger > agent precedence) and the
 *                       bridge sees a single, already-resolved cap on
 *                       `rendered_agent_json`.
 *
 * Enforcement lives in the event-bridge (`src/runs/stream/`): as pi's
 * cumulative `turn_end` cost crosses the cap mid-run, the bridge cancels
 * the burrow run and reaps it `cancelled`. The cap is the same number for
 * both knobs — there is exactly one effective ceiling per run.
 *
 * Cost values are read defensively. `cn --fm` stringifies frontmatter
 * values (the warren-5f07 string/boolean trap), so a canopy-authored
 * `maxCostUsd: 5` can arrive as the string `"5"`. `coerceCostCap`
 * accepts numbers and numeric strings; anything non-positive, NaN, or
 * unparseable resolves to `null` (no cap) so a malformed value fails
 * OPEN rather than wedging the run — a budget typo must never silently
 * cancel every run at $0.
 */

/** Frontmatter / triggers.yaml key carrying the per-run USD spend cap. */
export const MAX_COST_USD_KEY = "maxCostUsd";

/**
 * Coerce a raw frontmatter / config value into a positive USD cap.
 * Accepts numbers and numeric strings (cn --fm stringification). Returns
 * `null` for absent, non-positive, NaN, or unparseable values — i.e. "no
 * cap" — so a malformed budget fails open instead of cancelling at $0.
 */
export function coerceCostCap(raw: unknown): number | null {
	if (typeof raw === "number") {
		return Number.isFinite(raw) && raw > 0 ? raw : null;
	}
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed === "") return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	}
	return null;
}

/**
 * Read the per-agent spend cap from an agent definition's frontmatter
 * bag. Defensive against the cn --fm string trap (see module doc).
 */
export function readMaxCostUsd(frontmatter: Readonly<Record<string, unknown>>): number | null {
	return coerceCostCap(frontmatter[MAX_COST_USD_KEY]);
}

/**
 * Resolve the effective spend cap for a run from its frozen
 * `runs.rendered_agent_json`. The per-trigger override (when present) was
 * already folded onto the frontmatter at dispatch, so this is the single
 * source of truth at bridge time. Returns `null` when no cap applies.
 */
export function resolveCostCapUsd(renderedAgentJson: unknown): number | null {
	if (renderedAgentJson === null || typeof renderedAgentJson !== "object") return null;
	const frontmatter = (renderedAgentJson as Record<string, unknown>).frontmatter;
	if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
		return null;
	}
	return readMaxCostUsd(frontmatter as Record<string, unknown>);
}

/**
 * True when an observed cumulative cost has crossed the cap. A `null` cap
 * (no budget) is never over. The comparison is strict-greater so a run
 * that lands exactly on its cap is allowed to finish that turn.
 */
export function isOverBudget(costUsd: number, capUsd: number | null): boolean {
	if (capUsd === null) return false;
	return costUsd > capUsd;
}

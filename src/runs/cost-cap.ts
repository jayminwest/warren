/**
 * Spend-cap resolution + evaluation (warren-a63d).
 *
 * Warren historically tracked cost post-hoc only (`runs.cost_usd`) with
 * no enforcement anywhere — a runaway cron patrol (especially a
 * Fable-tier agent) had no ceiling. This module is the shared, pure core
 * of the per-agent / per-trigger spend cap:
 *
 *   - per-dispatch cap — one override slot, fed by mutually exclusive
 *                       sources: a `.warren/triggers.yaml` entry's
 *                       `maxCostUsd` (cron and manual fires), a
 *                       `POST /runs` `maxCostUsd` body field, or
 *                       `warren run --max-cost-usd`. Dispatch folds it
 *                       onto the agent frontmatter BEFORE freezing the
 *                       run row, so the bridge sees a single,
 *                       already-resolved cap on `rendered_agent_json`.
 *   - per-agent cap   — `frontmatter.maxCostUsd` on the agent
 *                       definition (frozen onto `runs.rendered_agent_json`).
 *   - project default — `maxCostUsd` on `.warren/config.yaml`, the
 *                       weakest source: applied only when no override
 *                       arrived and the agent declares no cap at all.
 *
 * `resolveCapOverride` is the one implementation of that precedence;
 * dispatch call sites go through it rather than re-deriving the chain.
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
 * Resolve the per-dispatch value to fold onto the agent's frontmatter
 * (via `withMaxCostUsdOverride`) for one spawn. Precedence: the explicit
 * `overrideUsd` (trigger entry / `POST /runs` body — one slot, mutually
 * exclusive sources) > the agent's own `frontmatter.maxCostUsd` (left in
 * place, no fold) > the project-wide `projectDefaultUsd`.
 *
 * The project default applies only when the frontmatter carries no
 * `maxCostUsd` at all. An explicit `null` counts as "no declaration" —
 * the same reading the HTTP boundary gives a `null` body field
 * (`optionalPositiveNumber`) — so the default applies there too; null
 * is an explicit non-value, not a typo. A present-but-malformed agent
 * value (a string, a negative) is NOT replaced: it stays on the frozen
 * `rendered_agent_json` (preserving the evidence of the typo) and fails
 * OPEN at the bridge per the module rule, exactly as it did before
 * project defaults existed.
 *
 * Returns `undefined` when nothing should be folded.
 */
export function resolveCapOverride(input: {
	readonly overrideUsd?: number;
	readonly frontmatter: Readonly<Record<string, unknown>>;
	readonly projectDefaultUsd?: number;
}): number | undefined {
	if (input.overrideUsd !== undefined) return input.overrideUsd;
	const declared = input.frontmatter[MAX_COST_USD_KEY];
	if (declared !== undefined && declared !== null) return undefined;
	return input.projectDefaultUsd;
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

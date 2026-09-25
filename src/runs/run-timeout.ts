/**
 * Per-run wall-clock cap resolution + evaluation (warren-a112).
 *
 * The sibling of the warren-a63d spend cap (`./cost-cap.ts`), and resolved
 * through the same three-tier chain:
 *
 *   - per-dispatch cap — one override slot: a `POST /runs` or
 *                       `POST /plan-runs` `maxDurationMinutes` body field,
 *                       or `warren run --max-duration-minutes`. Dispatch
 *                       folds it onto the agent frontmatter BEFORE freezing
 *                       the run row, so enforcement reads one resolved value
 *                       off `rendered_agent_json`.
 *   - per-agent cap   — `frontmatter.maxDurationMinutes` on the agent.
 *   - project default — `maxDurationMinutes` on `.warren/config.yaml`,
 *                       applied only when no override arrived and the agent
 *                       declares no cap at all.
 *
 * Enforcement lives in the heartbeat watchdog (`./watchdog.ts`), not in a
 * runtime provider. The watchdog already sweeps every `running` row on a
 * fixed tick and owns a provider-neutral force-fail (graceful
 * `provider.cancel`, then `reap` as `failed`), so a cap enforced there
 * works the same under local, docker, and k8s. The deadline is
 * `runs.started_at + cap`, both persisted, so it survives a warren restart.
 * `RunSpec.timeoutMs` stays unset: no provider honors it, and a
 * provider-side kill would bypass reap's branch push and teardown.
 *
 * Values are read defensively, like the spend cap: numbers and numeric
 * strings (the cn --fm stringification trap) pass; anything non-positive,
 * NaN, or unparseable resolves to `null` (no cap), so a malformed value
 * fails OPEN instead of killing every run at minute zero. The HTTP and
 * config boundaries are stricter (positive integers only).
 */

import type { RunRow } from "../db/schema.ts";
import type { AgentDefinition } from "../registry/schema.ts";

/** Frontmatter / config / body key carrying the per-run wall-clock cap. */
export const MAX_DURATION_MINUTES_KEY = "maxDurationMinutes";

/** Event kind the watchdog emits when a run outlives its wall-clock cap. */
export const DURATION_EXCEEDED_KIND = "duration.exceeded";

const MS_PER_MINUTE = 60_000;

/** Coerce a raw frontmatter / config value into a positive minute cap, else null. */
export function coerceDurationCap(raw: unknown): number | null {
	if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw.trim());
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	}
	return null;
}

/** Read the per-agent wall-clock cap (minutes) from a frontmatter bag. */
export function readMaxDurationMinutes(
	frontmatter: Readonly<Record<string, unknown>>,
): number | null {
	return coerceDurationCap(frontmatter[MAX_DURATION_MINUTES_KEY]);
}

/**
 * Resolve the value to fold onto the agent frontmatter for one spawn.
 * Precedence: explicit override > the agent's own declaration (left in
 * place, no fold) > project default. An explicit `null` in frontmatter
 * counts as "no declaration", matching `resolveCapOverride`. A
 * present-but-malformed agent value is NOT replaced: it stays on the frozen
 * row as evidence and fails open at enforcement. Returns `undefined` when
 * nothing should be folded.
 */
export function resolveDurationOverride(input: {
	readonly overrideMinutes?: number | undefined;
	readonly frontmatter: Readonly<Record<string, unknown>>;
	readonly projectDefaultMinutes?: number | undefined;
}): number | undefined {
	if (input.overrideMinutes !== undefined) return input.overrideMinutes;
	const declared = input.frontmatter[MAX_DURATION_MINUTES_KEY];
	if (declared !== undefined && declared !== null) return undefined;
	return input.projectDefaultMinutes;
}

/** Fold a resolved cap onto `frontmatter.maxDurationMinutes`; `undefined` is a no-op. */
export function withMaxDurationMinutesOverride(
	agent: AgentDefinition,
	minutes: number | undefined,
): AgentDefinition {
	if (minutes === undefined) return agent;
	return { ...agent, frontmatter: { ...agent.frontmatter, [MAX_DURATION_MINUTES_KEY]: minutes } };
}

/** The effective cap (minutes) frozen on a run's `rendered_agent_json`, else null. */
export function resolveRunMaxDurationMinutes(renderedAgentJson: unknown): number | null {
	if (renderedAgentJson === null || typeof renderedAgentJson !== "object") return null;
	const frontmatter = (renderedAgentJson as Record<string, unknown>).frontmatter;
	if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
		return null;
	}
	return readMaxDurationMinutes(frontmatter as Record<string, unknown>);
}

/** A `running` run that has reached its wall-clock deadline. */
export interface DurationOverrun {
	readonly maxDurationMinutes: number;
	readonly elapsedMs: number;
	readonly deadlineAt: string;
}

/**
 * Evaluate one run against its cap at `now`. Returns the overrun when the
 * run has a cap, a parseable `startedAt`, and `now >= startedAt + cap`;
 * otherwise null. A run with no `startedAt` never overruns (the clock
 * starts when the run does, not when it was queued).
 */
export function evaluateDurationCap(
	run: Pick<RunRow, "startedAt" | "renderedAgentJson">,
	now: Date,
): DurationOverrun | null {
	const maxDurationMinutes = resolveRunMaxDurationMinutes(run.renderedAgentJson);
	if (maxDurationMinutes === null || run.startedAt === null) return null;
	const startedMs = Date.parse(run.startedAt);
	if (!Number.isFinite(startedMs)) return null;
	const deadlineMs = startedMs + maxDurationMinutes * MS_PER_MINUTE;
	if (now.getTime() < deadlineMs) return null;
	return {
		maxDurationMinutes,
		elapsedMs: now.getTime() - startedMs,
		deadlineAt: new Date(deadlineMs).toISOString(),
	};
}

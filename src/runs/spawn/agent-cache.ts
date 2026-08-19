/**
 * Read-side helpers for the spawn flow: re-validate the cached
 * rendered-agent envelope, resolve operator / project frontmatter
 * overrides, and read the project's `.warren/defaults.json`. Extracted
 * from the legacy `src/runs/spawn.ts` under warren-f71c / pl-9088 step 6.
 */

import type { GatedPromptFragments } from "../../registry/prompt-gating.ts";
import {
	type AgentDefinition,
	parseRenderedAgent,
	RenderResponseSchema,
} from "../../registry/schema.ts";
import type {
	DefaultsConfig,
	WarrenConfigCache,
	WarrenConfigFileError,
} from "../../warren-config/index.ts";
import { WarrenConfigInvalidError, warrenConfigRelativePath } from "../../warren-config/index.ts";
import { RunSpawnError } from "../errors.ts";

/**
 * Re-validate the cached row's renderedJson before use. Refresh.ts stores
 * a parsed `AgentDefinition` directly, so the column shape is normally
 * exactly that — but the column type is `unknown`, and a corrupted row
 * shouldn't crash the spawn flow with a TypeError. If the cache holds the
 * raw `cn render` envelope (older registry refresh path), fall back to
 * parsing it.
 */
export function readCachedAgent(raw: unknown, name: string): AgentDefinition {
	if (typeof raw !== "object" || raw === null) {
		throw new RunSpawnError(`cached agent "${name}" has malformed renderedJson`);
	}
	const candidate = raw as Record<string, unknown>;
	if (
		typeof candidate.name === "string" &&
		typeof candidate.version === "number" &&
		typeof candidate.sections === "object" &&
		candidate.sections !== null &&
		!Array.isArray(candidate.sections)
	) {
		const sections = candidate.sections as Record<string, unknown>;
		for (const [key, value] of Object.entries(sections)) {
			if (typeof value !== "string") {
				throw new RunSpawnError(`cached agent "${name}" has non-string section "${key}"`);
			}
		}
		return {
			name: candidate.name,
			version: candidate.version,
			sections: sections as Record<string, string>,
			resolvedFrom: Array.isArray(candidate.resolvedFrom)
				? candidate.resolvedFrom.filter((s): s is string => typeof s === "string")
				: [],
			frontmatter:
				typeof candidate.frontmatter === "object" &&
				candidate.frontmatter !== null &&
				!Array.isArray(candidate.frontmatter)
					? (candidate.frontmatter as Record<string, unknown>)
					: {},
			// warren-cb46: capability-gated prompt fragments ride the row's
			// renderedJson; validated strings only.
			gatedPrompts: readCachedGatedPrompts(candidate.gatedPrompts, name),
		};
	}
	if (RenderResponseSchema.safeParse(raw).success) {
		return parseRenderedAgent(raw, name);
	}
	throw new RunSpawnError(`cached agent "${name}" does not match AgentDefinition shape`);
}

/**
 * Validate + return the row's gated prompt fragments (warren-cb46).
 * `undefined` when the row predates gated fragments; a present-but-malformed
 * fragment fails the spawn loudly rather than injecting junk into the prompt.
 */
function readCachedGatedPrompts(raw: unknown, name: string): GatedPromptFragments | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new RunSpawnError(`cached agent "${name}" has malformed gatedPrompts`);
	}
	const obj = raw as Record<string, unknown>;
	const result: { tracker?: string; mulch?: string } = {};
	for (const key of ["tracker", "mulch"] as const) {
		const value = obj[key];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			throw new RunSpawnError(`cached agent "${name}" has non-string gatedPrompts.${key}`);
		}
		result[key] = value;
	}
	return result;
}

/**
 * Pick the effective frontmatter override given a per-run operator value and
 * a project default. Empty / whitespace-only strings are treated the same as
 * "not provided" (matches `withProviderOverrides`'s shape). Returns the
 * operator value when present, otherwise the project default, otherwise
 * `undefined` so the agent's own frontmatter remains in force.
 */
export function resolveOverride(
	operator: string | undefined,
	projectDefault: string | undefined,
): string | undefined {
	const op = operator?.trim();
	if (op !== undefined && op !== "") return op;
	const pd = projectDefault?.trim();
	if (pd !== undefined && pd !== "") return pd;
	return undefined;
}

/**
 * The `.warren/` files that carry dispatch guardrails: the admission cap,
 * the quality gate, the resource limits, and the cost caps all live in the
 * global-defaults tier. A parse / schema failure in either tier means the
 * project HAS a policy we could not read (warren-02aa).
 *
 * `triggers.yaml` and `pr-template.md` are deliberately NOT in this list.
 * Neither constrains what a dispatched run may do, so a typo there keeps
 * degrading gracefully the way it always has.
 */
const GUARDRAIL_CONFIG_FILES: readonly string[] = [
	warrenConfigRelativePath("config"),
	warrenConfigRelativePath("defaults"),
];

/**
 * Fail closed on a present-but-unreadable guardrail file (warren-02aa).
 *
 * `DefaultsConfigSchema` is `.strict()`, so one unknown key rejects the
 * whole document and `loadWarrenConfig` yields `defaults: null` plus an
 * `errors[]` entry. Before this guard every consumer optional-chained past
 * that null and dispatched with no cap, no gate, no limits, and no spend
 * ceiling — the loudest possible failure rendered as the quietest possible
 * behavior.
 *
 * We keep whole-document strictness rather than salvaging section by
 * section. Per-section validation would still drop the very knob the
 * operator fat-fingered (`admission.maxConcurrentRun` silently uncaps the
 * project), which is the same bug in a smaller blast radius. Whole-document
 * strictness plus a dispatch-blocking failure is the only shape where a
 * typo cannot widen a guardrail.
 *
 * A project with NO config file at all is untouched: the loader reports no
 * errors, and dispatch proceeds on built-in defaults exactly as before.
 */
export function assertGuardrailConfigUsable(
	errors: readonly WarrenConfigFileError[],
	projectId: string,
): void {
	const blocking = errors.filter((err) => GUARDRAIL_CONFIG_FILES.includes(err.file));
	if (blocking.length === 0) return;
	const detail = blocking.map((err) => `${err.file}: ${err.message}`).join("; ");
	throw new WarrenConfigInvalidError(
		`project ${projectId} has an unreadable guardrail config, refusing dispatch — ${detail}`,
		{
			recoveryHint:
				"fix the reported file (unknown keys are rejected) and re-dispatch; " +
				"GET /projects/:id/warren-config shows the same errors",
		},
	);
}

/**
 * Load the project's global-defaults envelope through the cache.
 *
 * Returns `null` when no cache is wired (CLI/tests that don't care about
 * project defaults) or when the whole load failed at the filesystem level —
 * a vanished clone surfaces on the refresh path with a better error.
 *
 * Throws `WarrenConfigInvalidError` when a guardrail file exists but failed
 * to parse or validate (warren-02aa). Dispatch must not proceed as if the
 * project had no policy.
 */
export async function readProjectDefaults(
	cache: WarrenConfigCache | undefined,
	projectId: string,
	projectPath: string,
): Promise<DefaultsConfig | null> {
	if (cache === undefined) return null;
	let envelope: Awaited<ReturnType<WarrenConfigCache["get"]>>;
	try {
		envelope = await cache.get(projectId, projectPath);
	} catch {
		// Project clone vanished or .warren/ I/O errored — leave the agent
		// frontmatter as the final source of truth and let the rest of the
		// flow surface any project-state failure on its own path.
		return null;
	}
	assertGuardrailConfigUsable(envelope.errors, projectId);
	return envelope.defaults;
}

/**
 * Schemas for canopy `cn render` output and warren's normalized agent
 * definition (SPEC §4.2).
 *
 * `RenderResponseSchema` mirrors the wire shape canopy 0.2.x emits with
 * `--format json` — `{success, command, name, version, sections, ...}`.
 * Failure-shaped responses (`success: false`) are caught at the canopy
 * facade boundary, so the schema only needs to model the happy-path
 * envelope.
 *
 * `parseRenderedAgent` collapses the section list into a `name → body`
 * map (the rest of warren never cares about ordering — `cn render` already
 * resolved inheritance + mixins). It also enforces warren's semantic rule:
 * an agent prompt MUST include a `system` section. Other sections from
 * SPEC §4.2 (`skills`, `expertise_seed`, `burrow_config`, `workflow`) are
 * optional — they are consumed at run-spawn time (Phase 5), not now, and
 * canopy's own per-prompt schema is the right place to enforce richer
 * structural rules.
 *
 * Duplicate section names are rejected: canopy renders an inherited
 * prompt by overriding parent sections with same-named child sections, so
 * the rendered output should never contain dupes. If we see one, the
 * canopy install is corrupt — surface that loudly rather than silently
 * dropping data.
 */

import { z } from "zod";
import { AgentSchemaError } from "./errors.ts";

export const REQUIRED_AGENT_SECTIONS = ["system"] as const;
export type RequiredAgentSection = (typeof REQUIRED_AGENT_SECTIONS)[number];

const SectionSchema = z.object({
	name: z.string().min(1),
	body: z.string(),
});

export const RenderResponseSchema = z.object({
	success: z.literal(true),
	command: z.literal("render"),
	name: z.string().min(1),
	version: z.number().int().positive(),
	sections: z.array(SectionSchema),
	resolvedFrom: z.array(z.string()).optional(),
	frontmatter: z.record(z.string(), z.unknown()).optional(),
});

export type RenderResponse = z.infer<typeof RenderResponseSchema>;

export interface AgentDefinition {
	readonly name: string;
	readonly version: number;
	readonly sections: Readonly<Record<string, string>>;
	readonly resolvedFrom: readonly string[];
	readonly frontmatter: Readonly<Record<string, unknown>>;
}

/**
 * Well-known optional frontmatter fields the multi-provider surface reads:
 *
 *   provider — the runtime-side provider id (e.g. "anthropic", "openai",
 *              "google", "deepseek"). Free-form string; burrow's piRuntime
 *              maps it onto pi's --provider flag, claude-code ignores it.
 *   model    — provider-specific model id (e.g. "claude-sonnet-4-6",
 *              "gpt-4o", "gemini-2.0-pro"). Free-form string; the runtime
 *              decides how to interpret it.
 *   runtime  — burrow runtime id this canopy agent dispatches onto
 *              (e.g. "claude-code", "sapling", "pi"). When unset,
 *              warren falls back to `DEFAULT_RUNTIME_ID` ("pi") —
 *              the multi-provider runtime is the preferred default
 *              (warren-16f8). claude-code stays available but is now
 *              opt-in: pin it via this field. Built-in agents that
 *              want a non-pi runtime (claude-code / sapling) declare
 *              it here explicitly; interactive system-prompt-only
 *              agents like `brainstorm` / `planner` (warren-ebca) do
 *              the same so they compose onto a real burrow runtime.
 *   auto_plan_run — boolean (warren-a32a). When true and the agent's run
 *              succeeds, reap diffs `.seeds/plans.jsonl` to detect new
 *              plans created during execution and auto-dispatches a
 *              plan-run for each. Enables the patrol agent pattern:
 *              cron fires a scan agent, the agent files a plan, warren
 *              auto-executes it.
 *   auto_plan_run_agent — string (warren-65b2). When set, the auto-
 *              dispatched plan-run uses this agent name instead of
 *              inheriting the parent run's agent name. Prevents
 *              triage-only agents (bugwatch, nightwatch) from
 *              propagating their system prompt to child runs that
 *              need to write code. Falls back to the parent run's
 *              agentName when unset.
 *   tools    — object (warren-8dee). Per-agent tool allowlist/denylist
 *              consumed by the pi runtime: `{ allow?, deny?, noBuiltins?,
 *              noTools? }` → pi's `--tools` / `--exclude-tools` /
 *              `--no-builtin-tools` / `--no-tools`. Read + normalized by
 *              `readToolsFrontmatter`; gives reviewer / patrol agents a
 *              hard read-only guarantee at the harness level (paired
 *              warren↔burrow change, SPEC §11.K).
 *
 * Both stay in the open `frontmatter` bag (no schema rev) so a canopy
 * author can set them inline. `POST /runs` accepts the same two fields
 * as overrides; the spawn composer merges overrides on top of frontmatter
 * before freezing onto `runs.rendered_agent_json`.
 */
export function readProviderFrontmatter(frontmatter: Readonly<Record<string, unknown>>): {
	provider?: string;
	model?: string;
} {
	const result: { provider?: string; model?: string } = {};
	const p = frontmatter.provider;
	if (typeof p === "string" && p.length > 0) result.provider = p;
	const m = frontmatter.model;
	if (typeof m === "string" && m.length > 0) result.model = m;
	return result;
}

/**
 * Normalized per-agent tool policy (warren-8dee).
 *
 *   allow      — tool-name allowlist → pi's `--tools <a,b,c>`
 *   deny       — tool-name denylist  → pi's `--exclude-tools <a,b,c>`
 *   noBuiltins — drop the built-in tool set → pi's `--no-builtin-tools`
 *   noTools    — expose no tools at all → pi's `--no-tools`
 *
 * Only the `pi` runtime consumes this in V1 (paired warren↔burrow change,
 * SPEC §11.K); other runtimes ignore the field. The policy rides the open
 * `frontmatter` bag, so a canopy / `.warren` agent author declares it inline
 * with no schema rev, and it forwards to burrow on run metadata via the same
 * `composeBurrowMetadata` seam as `provider` / `model`.
 */
export interface ToolsPolicy {
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
	readonly noBuiltins?: boolean;
	readonly noTools?: boolean;
}

/**
 * Coerce a frontmatter value into a string array. Accepts a real `string[]`
 * (canopy artifact / typed `--fm key:=value` JSON) or a single
 * comma/whitespace-separated string (the shape `cn --fm key:value`
 * stringification produces — see the warren-5f07 string/boolean trap).
 * Returns `undefined` for empty / unusable input so an empty allowlist is
 * indistinguishable from omitting the field.
 */
function coerceToolNameList(
	value: unknown,
	label: string,
	agentName: string,
): string[] | undefined {
	let raw: unknown[];
	if (Array.isArray(value)) {
		raw = value;
	} else if (typeof value === "string") {
		raw = value.split(/[\s,]+/);
	} else {
		throw new AgentSchemaError(
			`agent "${agentName}" frontmatter.tools.${label} must be a string array or comma-separated string`,
		);
	}
	const names: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			throw new AgentSchemaError(
				`agent "${agentName}" frontmatter.tools.${label} entries must be strings`,
			);
		}
		const trimmed = entry.trim();
		if (trimmed.length > 0) names.push(trimmed);
	}
	return names.length > 0 ? names : undefined;
}

/**
 * Coerce a frontmatter value into a boolean, tolerating the `"true"` /
 * `"false"` strings `cn --fm` emits (warren-5f07). Returns `undefined` when
 * the field is absent; throws on a value that is neither a boolean nor a
 * recognized boolean string.
 */
function coerceToolFlag(value: unknown, label: string, agentName: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new AgentSchemaError(
		`agent "${agentName}" frontmatter.tools.${label} must be a boolean (or "true"/"false")`,
	);
}

/**
 * Parse, validate, and normalize `frontmatter.tools` (warren-8dee). Returns
 * `undefined` when the agent declares no tool policy; throws
 * `AgentSchemaError` on a malformed declaration so it surfaces at registry
 * refresh / spawn time rather than silently dropping a read-only guarantee.
 * The returned object is canonical (string arrays, real booleans) so burrow's
 * `buildPiArgv` reads a stable shape regardless of how the author authored it.
 */
export function readToolsFrontmatter(
	frontmatter: Readonly<Record<string, unknown>>,
	agentName = "<agent>",
): ToolsPolicy | undefined {
	const raw = frontmatter.tools;
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new AgentSchemaError(`agent "${agentName}" frontmatter.tools must be an object`);
	}
	const obj = raw as Record<string, unknown>;
	const policy: {
		allow?: string[];
		deny?: string[];
		noBuiltins?: boolean;
		noTools?: boolean;
	} = {};
	assignToolNameList(policy, "allow", obj.allow, agentName);
	assignToolNameList(policy, "deny", obj.deny, agentName);
	assignToolFlag(policy, "noBuiltins", obj.noBuiltins, agentName);
	assignToolFlag(policy, "noTools", obj.noTools, agentName);
	const empty =
		policy.allow === undefined &&
		policy.deny === undefined &&
		policy.noBuiltins === undefined &&
		policy.noTools === undefined;
	return empty ? undefined : policy;
}

function assignToolNameList(
	policy: { allow?: string[]; deny?: string[] },
	key: "allow" | "deny",
	value: unknown,
	agentName: string,
): void {
	if (value === undefined || value === null) return;
	const names = coerceToolNameList(value, key, agentName);
	if (names !== undefined) policy[key] = names;
}

function assignToolFlag(
	policy: { noBuiltins?: boolean; noTools?: boolean },
	key: "noBuiltins" | "noTools",
	value: unknown,
	agentName: string,
): void {
	const flag = coerceToolFlag(value, key, agentName);
	if (flag !== undefined) policy[key] = flag;
}

/**
 * Default burrow runtime id warren dispatches onto when an agent pins
 * none (warren-16f8). Pi is the multi-provider runtime — cost streams
 * in-band, the unified provider matrix works, and it's what most
 * dogfood runs use — so it's the preferred default; claude-code is
 * opt-in via `frontmatter.runtime`.
 */
export const DEFAULT_RUNTIME_ID = "pi";

/**
 * Resolve the burrow runtime id this canopy agent should dispatch onto.
 *
 * Precedence (warren-b802 / warren-16f8):
 *   1. `configOverride` — per-project `.warren/config.yaml`
 *      `interactiveAgents.brainstormRuntime` / `plannerRuntime`
 *   2. `frontmatter.runtime` — declared by built-ins that pin a
 *      specific runtime (claude-code / sapling) or compose a system
 *      prompt onto an existing runtime (brainstorm / planner,
 *      warren-ebca)
 *   3. `DEFAULT_RUNTIME_ID` ("pi") — the preferred default when
 *      nothing pins a runtime; claude-code is opt-in
 */
export function readRuntimeId(agent: AgentDefinition, configOverride?: string): string {
	if (typeof configOverride === "string" && configOverride.length > 0) return configOverride;
	const r = agent.frontmatter.runtime;
	if (typeof r === "string" && r.length > 0) return r;
	return DEFAULT_RUNTIME_ID;
}

/**
 * Return a new AgentDefinition with the operator's provider/model overrides
 * folded into `frontmatter` (taking precedence over the agent's own values).
 * Empty / whitespace-only overrides are ignored — they're treated the same
 * as omitting the field. The original agent is not mutated.
 */
export function withProviderOverrides(
	agent: AgentDefinition,
	overrides: { providerOverride?: string; modelOverride?: string },
): AgentDefinition {
	const provider = overrides.providerOverride?.trim();
	const model = overrides.modelOverride?.trim();
	if ((provider === undefined || provider === "") && (model === undefined || model === "")) {
		return agent;
	}
	const nextFrontmatter: Record<string, unknown> = { ...agent.frontmatter };
	if (provider !== undefined && provider !== "") nextFrontmatter.provider = provider;
	if (model !== undefined && model !== "") nextFrontmatter.model = model;
	return { ...agent, frontmatter: nextFrontmatter };
}

/**
 * Return a new AgentDefinition with a per-trigger spend cap (warren-a63d)
 * folded onto `frontmatter.maxCostUsd`, taking precedence over the
 * agent's own value (trigger > agent). `undefined` leaves the agent's
 * own `maxCostUsd` in force; the original agent is not mutated. Dispatch
 * calls this before freezing `runs.rendered_agent_json` so the bridge
 * sees a single, already-resolved cap.
 */
export function withMaxCostUsdOverride(
	agent: AgentDefinition,
	capUsd: number | undefined,
): AgentDefinition {
	if (capUsd === undefined) return agent;
	return { ...agent, frontmatter: { ...agent.frontmatter, maxCostUsd: capUsd } };
}

/**
 * Parse and semantically validate the JSON body returned by
 * `cn render <name> --format json`. Throws `AgentSchemaError` for
 * any malformed or incomplete shape.
 */
export function parseRenderedAgent(raw: unknown, agentName?: string): AgentDefinition {
	const parsed = RenderResponseSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AgentSchemaError(
			`canopy render output failed schema validation${agentName ? ` for "${agentName}"` : ""}: ${parsed.error.issues.map(formatZodIssue).join("; ")}`,
		);
	}
	const env = parsed.data;
	const sections: Record<string, string> = {};
	for (const section of env.sections) {
		if (Object.hasOwn(sections, section.name)) {
			throw new AgentSchemaError(
				`canopy render returned duplicate section "${section.name}" for agent "${env.name}"`,
			);
		}
		sections[section.name] = section.body;
	}
	const def: AgentDefinition = {
		name: env.name,
		version: env.version,
		sections,
		resolvedFrom: env.resolvedFrom ?? [],
		frontmatter: env.frontmatter ?? {},
	};
	validateAgentDefinition(def);
	// warren-8dee: freeze the normalized tool policy back onto frontmatter so
	// the rendered envelope (and the metadata warren forwards to burrow) carries
	// a canonical shape regardless of how the canopy author declared it.
	const toolsPolicy = readToolsFrontmatter(def.frontmatter, def.name);
	if (toolsPolicy !== undefined) {
		return { ...def, frontmatter: { ...def.frontmatter, tools: toolsPolicy } };
	}
	return def;
}

/**
 * Enforce warren's required-sections rule on an already-built
 * `AgentDefinition`. Reused by `parseRenderedAgent` (post-canopy-render)
 * and by the cross-tier composer (warren-44a3) so a composed agent that
 * still ends up missing `system` is skipped with the same error shape.
 */
export function validateAgentDefinition(def: AgentDefinition): void {
	for (const required of REQUIRED_AGENT_SECTIONS) {
		if (!Object.hasOwn(def.sections, required)) {
			throw new AgentSchemaError(`agent "${def.name}" is missing required section "${required}"`, {
				recoveryHint: `add a "${required}" section to the canopy prompt and re-render`,
			});
		}
	}
	// warren-8dee: reject a malformed tools policy here (parse-time + cross-tier
	// composer) so an unenforceable read-only declaration surfaces loudly.
	readToolsFrontmatter(def.frontmatter, def.name);
}

/**
 * Read `auto_plan_run_agent` from agent frontmatter (warren-65b2).
 * Returns the override agent name, or `undefined` when unset.
 */
export function readAutoPlanRunAgent(
	frontmatter: Readonly<Record<string, unknown>>,
): string | undefined {
	const v = frontmatter.auto_plan_run_agent;
	if (typeof v === "string" && v.length > 0) return v;
	return undefined;
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}

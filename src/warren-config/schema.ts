/**
 * Zod schemas for the per-project `.warren/` config files.
 *
 * Files (warren-5840 reorg):
 *   triggers.yaml    array of trigger entries (YAML for cron readability)
 *   config.yaml      per-project defaults (canonical, YAML)
 *   preview.yaml     hoisted preview block (PreviewConfigSchema at top level)
 *   defaults.json    legacy per-project defaults (JSON, loader falls back here
 *                    with a deprecation warning — same DefaultsConfigSchema)
 *
 * `parseConfigFile` parses `config.yaml` / legacy `defaults.json` against
 * `DefaultsConfigSchema`. `parsePreviewFile` parses a standalone
 * `preview.yaml` whose top-level document is the preview block itself. The
 * preview block accepts an optional `mode: path | subdomain` field
 * (warren-fcb7 / docs/design/preview-environments.md path-mode addendum) so a project can pin a
 * routing mode for its previews; `WARREN_PREVIEW_MODE` (operator-facing,
 * env) wins on conflict — precedence is enforced at consumption time.
 *
 * Triggers carry a `kind: 'cron'` discriminator even though only cron is
 * implemented today. Per pl-5d74 risk #1, this leaves room for future
 * webhook-style triggers (R-06+) as another `kind:` without a schema rev.
 *
 * Triggers are parsed and exposed by this module but NOT dispatched here —
 * R-06 (cron scheduler) is the consumer. Defaults are parsed; the NewRun
 * UI consumes `defaultRole` (warren-fd14) by auto-filling its agent picker
 * and `defaultPrompt` (warren-af38) by pre-filling its prompt textarea
 * when the project declares one. `defaultProvider` / `defaultModel`
 * (warren-618b) are folded into the agent's frontmatter at spawn time, in
 * the same precedence slot as per-run overrides — operator override >
 * project default > agent frontmatter. `runBranchPrefix` (warren-9993)
 * overrides the prefix warren uses when composing the burrow branch as
 * `${prefix}/${run.id}`; precedence is project default >
 * WARREN_RUN_BRANCH_PREFIX env > built-in "burrow". CLI `warren run`
 * consumption of `defaultRole`, scheduled-run prompt fallback for
 * `defaultPrompt`, and any template substitution are deferred to R-04 / R-06.
 *
 * `parseTriggersConfig` and `parseDefaultsConfig` return discriminated
 * results — the loader collects `{ ok: false }` shapes into the per-file
 * errors envelope so a malformed sibling never throws.
 */

import { z } from "zod";
import { KNOWN_RUNTIME_IDS } from "../core/wire.ts";
import { parseDurationMs } from "../preview/duration.ts";
// warren-2b75: one agent-name grammar, owned by the registry and shared
// here so role names and registry names can never drift apart.
import { AGENT_NAME_PATTERN } from "../registry/agent-name.ts";
import { CiFixerConfigSchema, HealerConfigSchema } from "./feature-loop-config.ts";
import { AdmissionConfigSchema, ResourcesConfigSchema } from "./resources-config.ts";

// warren-3db0: re-exported so the historical import sites (and
// `warren-config/index.ts`) keep resolving these from `./schema.ts`
// after the extraction into `feature-loop-config.ts`.
export {
	type CiFixerConfig,
	CiFixerConfigSchema,
	DEFAULT_CI_FIXER_COOLDOWN_MINUTES,
	DEFAULT_CI_FIXER_LOG_TAIL_LINES,
	DEFAULT_CI_FIXER_MAX_RETRIES,
	DEFAULT_CI_FIXER_ROLE,
	DEFAULT_HEALER_COOLDOWN_MINUTES,
	DEFAULT_HEALER_MAX_RETRIES,
	DEFAULT_HEALER_ROLE,
	type HealerConfig,
	HealerConfigSchema,
} from "./feature-loop-config.ts";
// warren-ac7a / pl-829f step 14: K8s resource + network defaults re-exported
// from `resources-config.ts` (extracted for the file-size budget).
export {
	type AdmissionConfig,
	AdmissionConfigSchema,
	DEFAULT_K8S_CPU_LIMIT_MILLICORES,
	DEFAULT_K8S_CPU_REQUEST_MILLICORES,
	DEFAULT_K8S_MEMORY_LIMIT_MIB,
	DEFAULT_K8S_MEMORY_REQUEST_MIB,
	DEFAULT_K8S_NETWORK,
	type NetworkPolicy,
	NetworkPolicySchema,
	type ResourcesConfig,
	ResourcesConfigSchema,
} from "./resources-config.ts";

const TriggerIdSchema = z
	.string()
	.min(1, "id must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"id must be kebab/snake-case (lowercase, digits, dots, dashes, underscores)",
	);

const SeedRefSchema = z.string().min(1, "seed must be non-empty");

const RoleNameSchema = z
	.string()
	.min(1, "role must be non-empty")
	.regex(
		AGENT_NAME_PATTERN,
		"role must be a canopy agent name (lowercase, digits, dots, dashes, underscores)",
	);

// warren-9993: the branch warren passes to `burrows.up` is `<prefix>/<run.id>`,
// where the run id is the warren `run_xxxxxxxxxxxx` so the branch traces back
// to the warren run on `git log` / PR review. Same kebab/snake-case grammar
// as RoleNameSchema; slashes inside the prefix are disallowed so the
// `<prefix>/<id>` shape stays a single ref segment under the prefix.
const RunBranchPrefixSchema = z
	.string()
	.min(1, "runBranchPrefix must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"runBranchPrefix must be kebab/snake-case (lowercase, digits, dots, dashes, underscores)",
	);

const CronExpressionSchema = z
	.string()
	.min(1, "cron must be non-empty")
	// Loose parse: warren validates the structural shape (5 or 6 whitespace-
	// separated tokens). R-06 owns full cron validation when it wires up the
	// scheduler — duplicating croner's grammar here would lock the version.
	.refine(
		(value) => {
			const tokens = value.trim().split(/\s+/);
			return tokens.length === 5 || tokens.length === 6;
		},
		{ message: "cron must have 5 or 6 whitespace-separated fields" },
	);

const TimezoneSchema = z.string().min(1, "timezone must be non-empty if provided");

const PromptSchema = z.string().min(1, "prompt must be non-empty if provided");

// warren-7be9 / docs/design/preview-environments.md: idle_ttl and max_lifetime are both string-duration
// fields (e.g. "30m", "8h", "1h30m"). The launcher / eviction worker parses
// these into milliseconds; the schema only validates shape so malformed input
// surfaces in the per-file errors envelope before reap-time. Compound forms
// like "1h30m" are accepted so operators don't have to pre-do the math.
const DurationStringSchema = z
	.string()
	.min(1, "duration must be non-empty if provided")
	.regex(
		/^(\d+(ms|s|m|h|d))+$/,
		'duration must be one or more <number><unit> pairs (units: ms, s, m, h, d) — e.g. "30m", "8h", "1h30m"',
	);

const PreviewCommandSchema = z.string().min(1, "preview.command must be non-empty");

// TCP port the preview server binds to inside the sandbox. Privileged ports
// (1-1023) are accepted because the sandbox runs unprivileged-by-namespace —
// rejecting them here would surprise operators whose dev server binds 80/443.
const PreviewPortSchema = z
	.number()
	.int("preview.port must be an integer")
	.min(1, "preview.port must be between 1 and 65535")
	.max(65535, "preview.port must be between 1 and 65535");

const PreviewReadinessPathSchema = z
	.string()
	.min(1, "preview.readiness_path must be non-empty if provided")
	.regex(/^\//, "preview.readiness_path must start with '/'");

// Try-parse a duration string and return null when the shape doesn't match.
// Used by bounded duration refines (readiness_timeout, setup_timeout,
// connect_timeout) — zod
// runs `.refine()` even after a sibling `.regex()` check fails, so the refine
// must tolerate inputs the upstream regex would have rejected without
// re-raising parseDurationMs's ValidationError as an uncaught throw.
function tryParseDurationMs(value: string): number | null {
	try {
		return parseDurationMs(value);
	} catch {
		return null;
	}
}

// warren-0928: per-project override of the readiness probe wall clock. Bounds
// rule out pathological config (sub-second polls aren't meaningful given the
// 500ms default poll interval, and >1h is almost certainly a typo since the
// probe returns on first 2xx — larger ceilings only delay failure reporting).
// Operators who genuinely need >1h should file a follow-up so the upper bound
// gets revisited with a concrete use case.
const PreviewReadinessTimeoutSchema = DurationStringSchema.refine(
	(value) => {
		const ms = tryParseDurationMs(value);
		return ms !== null && ms >= 1_000 && ms <= 3_600_000;
	},
	{ message: "preview.readiness_timeout must be between 1s and 1h" },
);

// warren-d9e7: setup runs as its own sidecar before the dev-server sidecar so
// dependency install ("pnpm install") and dev-server bind no longer share a
// readiness_timeout. Same 1s..1h bounds as readiness_timeout — sized to cover
// a cold pnpm/npm install but tight enough that a runaway install fails fast.
const PreviewSetupTimeoutSchema = DurationStringSchema.refine(
	(value) => {
		const ms = tryParseDurationMs(value);
		return ms !== null && ms >= 1_000 && ms <= 3_600_000;
	},
	{ message: "preview.setup_timeout must be between 1s and 1h" },
);

// warren-9b15: separates "did anything bind on the port?" from "is the bound
// server returning 2xx?". The phase-1 deadline covers shell pre-exec, dev-
// server CLI startup, and port bind — i.e. sidecar startup overhead that
// varies with burrow health and image cold cache, not bundler work. Phase 2
// (readiness_timeout) starts at first successful TCP connect. Same 1s..1h
// bounds and "try-parse" pattern as the sibling timeouts.
const PreviewConnectTimeoutSchema = DurationStringSchema.refine(
	(value) => {
		const ms = tryParseDurationMs(value);
		return ms !== null && ms >= 1_000 && ms <= 3_600_000;
	},
	{ message: "preview.connect_timeout must be between 1s and 1h" },
);

const PreviewSetupSchema = z.string().min(1, "preview.setup must be non-empty");

const AgentConfigSchema = z
	.object({
		skipGitHooks: z.boolean().optional(), // warren-8f4c: skip git-hooks arming on the host clone
	})
	.strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// warren-b802: per-project override of the burrow runtime backing the
// planner interactive built-in agent. Without this, an
// operator must stand up a canopy library just to change the runtime
// field. Validated against the known burrow runtime ids so a typo
// surfaces at config-load time, not at burrow boot.
//
// warren-c4be: the id vocabulary itself is canonical in `src/core/wire.ts`
// because the agent registry validates against the same list. Re-export,
// never re-list.
export { KNOWN_RUNTIME_IDS, type RuntimeId } from "../core/wire.ts";

const RuntimeIdSchema = z.enum(KNOWN_RUNTIME_IDS);

const InteractiveAgentsConfigSchema = z
	.object({
		plannerRuntime: RuntimeIdSchema.optional(),
	})
	.strict();

export type InteractiveAgentsConfig = z.infer<typeof InteractiveAgentsConfigSchema>;

// warren-fcb7 / docs/design/preview-environments.md (path-mode addendum, pl-f4ea): per-project pin of
// the preview routing mode. Operator-facing surface is `WARREN_PREVIEW_MODE`
// in env; this top-level field on `.warren/preview.yaml` lets a project
// declare its own preference when the operator runs warren in a mixed
// configuration. Env wins on conflict — merge precedence is enforced at
// consumption time, not in this schema.
export const PreviewModeSchema = z.enum(["path", "subdomain"]);

export type PreviewMode = z.infer<typeof PreviewModeSchema>;

/** Default routing mode when neither env nor per-project pin is set. */
export const DEFAULT_PREVIEW_MODE: PreviewMode = "path";

// warren-7be9 / docs/design/preview-environments.md: the schema carries a `type` discriminator from
// day one so V2 can add `type: 'static'` (build step + dir to serve) without
// breaking the config. V1 implements only `type: 'server'`. `type: 'static'`
// is accepted by the parser but rejected at launch time by the reap-step
// launcher (warren-f156) with an error that names the follow-up seed.
const ServerPreviewConfigSchema = z
	.object({
		type: z.literal("server"),
		mode: PreviewModeSchema.optional(),
		command: PreviewCommandSchema,
		// warren-d9e7: optional pre-step. Runs to completion before the dev
		// server sidecar spawns; non-zero exit fails the preview before the
		// readiness probe is attempted. See `src/preview/launch/index.ts`.
		setup: PreviewSetupSchema.optional(),
		setup_timeout: PreviewSetupTimeoutSchema.optional(),
		port: PreviewPortSchema,
		readiness_path: PreviewReadinessPathSchema.optional(),
		readiness_timeout: PreviewReadinessTimeoutSchema.optional(),
		// warren-9b15: phase-1 "did anything bind?" budget. Distinct from
		// readiness_timeout (phase 2, "is the bound server returning 2xx?")
		// so a slow burrow / cold image / shell pre-exec hang surfaces as
		// connect_timeout instead of eating the bundler budget.
		connect_timeout: PreviewConnectTimeoutSchema.optional(),
		idle_ttl: DurationStringSchema.optional(),
		max_lifetime: DurationStringSchema.optional(),
	})
	.strict();

// Static preview shape is intentionally permissive at the schema layer — the
// follow-up seed under pl-2c59 will lock its fields. We pin only the `type`
// discriminator so the launcher can recognize and reject it with a
// "not yet implemented" message that names that seed.
const StaticPreviewConfigSchema = z
	.object({
		type: z.literal("static"),
		mode: PreviewModeSchema.optional(),
	})
	.passthrough();

export const PreviewConfigSchema = z.discriminatedUnion("type", [
	ServerPreviewConfigSchema,
	StaticPreviewConfigSchema,
]);

export type ServerPreviewConfig = z.infer<typeof ServerPreviewConfigSchema>;
export type StaticPreviewConfig = z.infer<typeof StaticPreviewConfigSchema>;
export type PreviewConfig = z.infer<typeof PreviewConfigSchema>;

// warren-a63d: per-run USD spend cap, shared by the trigger entry and the
// project-wide default below so both sites can never validate differently.
const MaxCostUsdSchema = z.number().positive("maxCostUsd must be positive").finite();

// warren-a63d: per-trigger spend cap (USD); folded onto agent frontmatter
// (trigger > agent) and enforced mid-run by the bridge. Positive finite.
const CronTriggerSchema = z
	.object({
		id: TriggerIdSchema,
		kind: z.literal("cron"),
		cron: CronExpressionSchema,
		seed: SeedRefSchema.optional(),
		role: RoleNameSchema,
		timezone: TimezoneSchema.optional(),
		prompt: PromptSchema.optional(),
		maxCostUsd: MaxCostUsdSchema.optional(),
	})
	.strict();

export const TriggerSchema = z.discriminatedUnion("kind", [CronTriggerSchema]);

export const TriggersConfigSchema = z.array(TriggerSchema).superRefine((list, ctx) => {
	const seen = new Set<string>();
	list.forEach((entry, index) => {
		if (seen.has(entry.id)) {
			ctx.addIssue({
				code: "custom",
				path: [index, "id"],
				message: `duplicate trigger id "${entry.id}"`,
			});
		}
		seen.add(entry.id);
	});
});

export type CronTrigger = z.infer<typeof CronTriggerSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggersConfig = z.infer<typeof TriggersConfigSchema>;

export const DefaultsConfigSchema = z
	.object({
		defaultRole: RoleNameSchema.optional(),
		defaultBranch: z.string().min(1, "defaultBranch must be non-empty if provided").optional(),
		defaultPrompt: PromptSchema.optional(),
		// warren-618b: free-text provider/model defaults applied at spawn time the
		// same way per-run overrides are (operator > project default > frontmatter).
		defaultProvider: z.string().min(1, "defaultProvider must be non-empty if provided").optional(),
		defaultModel: z.string().min(1, "defaultModel must be non-empty if provided").optional(),
		// warren-9993: run branch prefix; spawnRun composes `${prefix}/${run.id}`.
		// Precedence: project default > WARREN_RUN_BRANCH_PREFIX env > "burrow".
		runBranchPrefix: RunBranchPrefixSchema.optional(),
		// warren-7be9 / docs/design/preview-environments.md: per-run preview environments (R-19). Canonical
		// home is `.warren/preview.yaml` (post-warren-5840); this nested field is
		// still accepted for migration — when both exist, `preview.yaml` wins.
		preview: PreviewConfigSchema.optional(),
		// warren-8f4c: per-project agent-runtime knobs (only `skipGitHooks`
		// today). Missing block → defaults apply.
		agent: AgentConfigSchema.optional(),
		// warren-b802: override of the burrow runtime backing interactive built-in
		// agents. Precedence: config override > agent frontmatter.runtime > name.
		interactiveAgents: InteractiveAgentsConfigSchema.optional(),
		// warren-ac7a / pl-829f step 14: K8s pod resource + network defaults
		// (design §3.1). Absent → the pod-spec builder uses DEFAULT_K8S_* constants.
		resources: ResourcesConfigSchema.optional(),
		// warren-b6f2: per-project admission control (K8s, design §3.3).
		admission: AdmissionConfigSchema.optional(),
		// Project-wide default spend cap (USD), the weakest source in the
		// warren-a63d cap chain: dispatch override (a trigger entry's cap or a
		// POST /runs body field — one slot, mutually exclusive sources) > agent
		// frontmatter > this. Resolved by resolveCapOverride (src/runs/cost-cap.ts)
		// and enforced mid-run by the event bridge.
		maxCostUsd: MaxCostUsdSchema.optional(),
		// warren-05ea: opt-in polling CI-fixer; missing block → poller skips it.
		ciFixer: CiFixerConfigSchema.optional(),
		// warren-3db0: opt-in closed-loop healer; missing block → intake skips it.
		healer: HealerConfigSchema.optional(),
		qualityGate: z.string().min(1, "qualityGate must be non-empty if provided").optional(),
	})
	.strict();

export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

export function parseTriggersConfig(raw: unknown): ParseResult<TriggersConfig> {
	// Empty / comment-only file (parses to undefined) is the same as "no triggers"
	// — operators should be able to scaffold the file without forcing an
	// explicit empty list literal.
	if (raw === undefined || raw === null) {
		return { ok: true, value: [] };
	}
	const parsed = TriggersConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

export function parseDefaultsConfig(raw: unknown): ParseResult<DefaultsConfig> {
	// Empty file (`{}` or undefined) is valid — operators may keep the file
	// around as documentation even when no overrides are set.
	if (raw === undefined || raw === null) {
		return { ok: true, value: {} };
	}
	const parsed = DefaultsConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

/**
 * Alias for `parseDefaultsConfig` used by the `config.yaml` loader path
 * (warren-5840). The schema is identical — only the call site naming and
 * the source filename differ — but the alias keeps the loader readable
 * and gives future divergence a single seam to hook into.
 */
export function parseConfigFile(raw: unknown): ParseResult<DefaultsConfig> {
	return parseDefaultsConfig(raw);
}

/**
 * Parse a standalone `preview.yaml` (warren-5840). The top-level document
 * is the preview block itself, not nested under a `preview:` key — that's
 * the whole point of the file split. Empty / missing top-level is treated
 * as "no preview configured" (parses to `null`) so operators can keep the
 * file around as documentation without forcing a placeholder.
 */
export function parsePreviewFile(raw: unknown): ParseResult<PreviewConfig | null> {
	if (raw === undefined || raw === null) {
		return { ok: true, value: null };
	}
	const parsed = PreviewConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

/**
 * Look up the per-agent runtime override from a project's
 * `interactiveAgents` config block. Returns `undefined` when no
 * override is configured for the given agent name.
 */
export function interactiveRuntimeOverride(
	agentName: string,
	defaults: DefaultsConfig | null | undefined,
): string | undefined {
	if (defaults?.interactiveAgents === undefined) return undefined;
	if (agentName === "planner") return defaults.interactiveAgents.plannerRuntime;
	return undefined;
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}

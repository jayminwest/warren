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
 * (warren-fcb7 / SPEC §11.L path-mode addendum) so a project can pin a
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
import { parseDurationMs } from "../preview/duration.ts";

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
		/^[a-z0-9][a-z0-9._-]*$/,
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

// warren-7be9 / SPEC §11.L: idle_ttl and max_lifetime are both string-duration
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

// warren-cd37 / SPEC §11.O (pl-0344 step 2): wall-clock budget for paused interactive turns.
// `question_posed` transitions the run to `paused`; if `question_answered` doesn't arrive within
// this window the supervisor respawns with a timeout warning (warren-2976). Bounds: 1s..24h.
// Field is `.default()`-backed; the `DEFAULT_*` constant is the fallback when the block is absent.
export const DEFAULT_AGENT_PAUSE_TIMEOUT_MS = 1_800_000; // 30 minutes

const AgentPauseTimeoutMsSchema = z
	.number()
	.int("agent.pauseTimeoutMs must be an integer (milliseconds)")
	.min(1_000, "agent.pauseTimeoutMs must be between 1s (1000) and 24h (86400000)")
	.max(86_400_000, "agent.pauseTimeoutMs must be between 1s (1000) and 24h (86400000)");

const AgentConfigSchema = z
	.object({
		pauseTimeoutMs: AgentPauseTimeoutMsSchema.default(DEFAULT_AGENT_PAUSE_TIMEOUT_MS),
		skipGitHooks: z.boolean().optional(), // warren-8f4c: skip git-hooks arming on the host clone
	})
	.strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// warren-005d: idle-timeout budget for a
// mode:"conversation" anchoring run. The run stays non-terminal across turns,
// so warren owns the deadline; when `now - conversations.last_activity_at`
// exceeds this, the coordinator finalizes ONLY the run (→ succeeded) — the
// conversation stays status='active' and the `messages` transcript survives.
// Mirrors `agent.pauseTimeoutMs` (bounds 1s..24h, `.default()`-backed); the
// `DEFAULT_*` constant is the fallback when the block is absent.
export const DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS = 1_200_000; // 20 minutes

const ConversationIdleTimeoutMsSchema = z
	.number()
	.int("conversation.idleTimeoutMs must be an integer (milliseconds)")
	.min(1_000, "conversation.idleTimeoutMs must be between 1s (1000) and 24h (86400000)")
	.max(86_400_000, "conversation.idleTimeoutMs must be between 1s (1000) and 24h (86400000)");

const ConversationConfigSchema = z
	.object({
		idleTimeoutMs: ConversationIdleTimeoutMsSchema.default(DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS),
	})
	.strict();

export type ConversationConfig = z.infer<typeof ConversationConfigSchema>;

// warren-cd22: per-project configuration for plot sync to GitHub (pl-5a6c).
// mergeStrategy controls when changes are merged (immediate / auto / manual).
// targetBranch overrides the default branch when pushing changes.
const PlotSyncMergeStrategySchema = z.enum(["immediate", "auto", "manual"]);

export type PlotSyncMergeStrategy = z.infer<typeof PlotSyncMergeStrategySchema>;

const PlotSyncConfigSchema = z
	.object({
		mergeStrategy: PlotSyncMergeStrategySchema.optional(),
		targetBranch: z.string().min(1, "targetBranch must be non-empty if provided").optional(),
	})
	.strict();

export type PlotSyncConfig = z.infer<typeof PlotSyncConfigSchema>;

// warren-05ea: per-project opt-in for the polling CI-fixer (V1). When
// `enabled`, warren's CI-status poller watches the project's own PRs
// (matched via `runs.prUrl`) and, on a failing check-run, dispatches a
// `pr-fixer` run against the existing PR branch. Off by default — a
// missing block means "not opted in". Numeric knobs carry `.default()`
// so consumers always see concrete numbers; the `DEFAULT_CI_FIXER_*`
// constants are the fallbacks when the whole block is absent.
export const DEFAULT_CI_FIXER_MAX_RETRIES = 2;
export const DEFAULT_CI_FIXER_COOLDOWN_MINUTES = 10;
export const DEFAULT_CI_FIXER_LOG_TAIL_LINES = 200;
export const DEFAULT_CI_FIXER_ROLE = "pr-fixer";

const boundedInt = (field: string, min: number, max: number) =>
	z
		.number()
		.int(`${field} must be an integer`)
		.min(min, `${field} must be between ${min} and ${max}`)
		.max(max, `${field} must be between ${min} and ${max}`);

const CiFixerConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		maxRetries: boundedInt("ciFixer.maxRetries", 0, 10).default(DEFAULT_CI_FIXER_MAX_RETRIES),
		cooldownMinutes: boundedInt("ciFixer.cooldownMinutes", 0, 1_440).default(
			DEFAULT_CI_FIXER_COOLDOWN_MINUTES,
		),
		logTailLines: boundedInt("ciFixer.logTailLines", 1, 2_000).default(
			DEFAULT_CI_FIXER_LOG_TAIL_LINES,
		),
		role: RoleNameSchema.default(DEFAULT_CI_FIXER_ROLE),
	})
	.strict();

export type CiFixerConfig = z.infer<typeof CiFixerConfigSchema>;

// warren-b802: per-project override of the burrow runtime backing the
// interactive built-in agents (brainstorm / planner). Without this, an
// operator must stand up a canopy library just to change the runtime
// field. Validated against the known burrow runtime ids so a typo
// surfaces at config-load time, not at burrow boot.
export const KNOWN_RUNTIME_IDS = ["claude-code", "sapling", "pi"] as const;
export type RuntimeId = (typeof KNOWN_RUNTIME_IDS)[number];

const RuntimeIdSchema = z.enum(KNOWN_RUNTIME_IDS);

const InteractiveAgentsConfigSchema = z
	.object({
		brainstormRuntime: RuntimeIdSchema.optional(),
		plannerRuntime: RuntimeIdSchema.optional(),
	})
	.strict();

export type InteractiveAgentsConfig = z.infer<typeof InteractiveAgentsConfigSchema>;

// warren-fcb7 / SPEC §11.L (path-mode addendum, pl-f4ea): per-project pin of
// the preview routing mode. Operator-facing surface is `WARREN_PREVIEW_MODE`
// in env; this top-level field on `.warren/preview.yaml` lets a project
// declare its own preference when the operator runs warren in a mixed
// configuration. Env wins on conflict — merge precedence is enforced at
// consumption time, not in this schema.
export const PreviewModeSchema = z.enum(["path", "subdomain"]);

export type PreviewMode = z.infer<typeof PreviewModeSchema>;

/** Default routing mode when neither env nor per-project pin is set. */
export const DEFAULT_PREVIEW_MODE: PreviewMode = "path";

// warren-7be9 / SPEC §11.L: the schema carries a `type` discriminator from
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
		maxCostUsd: z.number().positive("maxCostUsd must be positive").finite().optional(),
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
		// warren-7be9 / SPEC §11.L: per-run preview environments (R-19). Canonical
		// home is `.warren/preview.yaml` (post-warren-5840); this nested field is
		// still accepted for migration — when both exist, `preview.yaml` wins.
		preview: PreviewConfigSchema.optional(),
		// warren-cd37 / SPEC §11.O: per-project agent-runtime knobs (only
		// `pauseTimeoutMs` today). Missing block → use the DEFAULT_* fallback.
		agent: AgentConfigSchema.optional(),
		// warren-005d: conversation-runtime knobs (`idleTimeoutMs`).
		conversation: ConversationConfigSchema.optional(),
		// warren-b802: override of the burrow runtime backing interactive built-in
		// agents. Precedence: config override > agent frontmatter.runtime > name.
		interactiveAgents: InteractiveAgentsConfigSchema.optional(),
		// warren-cd22: per-project plot-sync-to-GitHub configuration.
		plotSync: PlotSyncConfigSchema.optional(),
		// warren-05ea: opt-in polling CI-fixer; missing block → poller skips it.
		ciFixer: CiFixerConfigSchema.optional(),
		qualityGate: z.string().min(1, "qualityGate must be non-empty if provided").optional(),
	})
	.strict();

export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

export function parseTriggersConfig(raw: unknown): ParseResult<TriggersConfig> {
	// Empty file (yaml.load returns undefined) is the same as "no triggers"
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
	if (agentName === "brainstorm") return defaults.interactiveAgents.brainstormRuntime;
	if (agentName === "planner") return defaults.interactiveAgents.plannerRuntime;
	return undefined;
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}

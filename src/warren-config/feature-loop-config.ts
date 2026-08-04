/**
 * Per-project config blocks for warren's two closed-loop repair features
 * (extracted from `schema.ts` to keep that file under the size budget):
 *
 *   - `ciFixer` (warren-05ea) — polling CI-fixer. When `enabled`, warren's
 *     CI-status poller watches the project's own PRs (matched via
 *     `runs.prUrl`) and, on a failing check-run, dispatches a `pr-fixer`
 *     run against the existing PR branch.
 *   - `healer` (warren-3db0) — closed-loop alert healer. When `enabled`, a
 *     `POST /alerts/heal` webhook (Sentry/Grafana) that resolves to the
 *     project dispatches a `healer` run. `projectMapping` is the static
 *     alert→project routing key list; intake falls back to the alert's
 *     inferred repo vs. the git URL. See `projectMapping` below for the
 *     matching semantics.
 *
 * Both are off by default — a missing block means "not opted in". Numeric
 * knobs carry `.default()` so consumers always see concrete numbers; the
 * `DEFAULT_*` constants are the fallbacks when the whole block is absent.
 */

import { z } from "zod";

import { AGENT_NAME_PATTERN } from "../registry/agent-name.ts";

// Same kebab/snake-case grammar as the cron-trigger `role` field — a canopy
// agent name. The pattern is shared from the registry (warren-2b75); the
// schema stays local so this module doesn't import back into schema.ts
// (which imports these schemas) and create a cycle.
const RoleNameSchema = z
	.string()
	.min(1, "role must be non-empty")
	.regex(
		AGENT_NAME_PATTERN,
		"role must be a canopy agent name (lowercase, digits, dots, dashes, underscores)",
	);

const boundedInt = (field: string, min: number, max: number) =>
	z
		.number()
		.int(`${field} must be an integer`)
		.min(min, `${field} must be between ${min} and ${max}`)
		.max(max, `${field} must be between ${min} and ${max}`);

export const DEFAULT_CI_FIXER_MAX_RETRIES = 2;
export const DEFAULT_CI_FIXER_COOLDOWN_MINUTES = 10;
export const DEFAULT_CI_FIXER_LOG_TAIL_LINES = 200;
export const DEFAULT_CI_FIXER_ROLE = "pr-fixer";

export const CiFixerConfigSchema = z
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

export const DEFAULT_HEALER_MAX_RETRIES = 3;
export const DEFAULT_HEALER_COOLDOWN_MINUTES = 30;
export const DEFAULT_HEALER_ROLE = "healer";

export const HealerConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		maxRetries: boundedInt("healer.maxRetries", 0, 20).default(DEFAULT_HEALER_MAX_RETRIES),
		cooldownMinutes: boundedInt("healer.cooldownMinutes", 0, 1_440).default(
			DEFAULT_HEALER_COOLDOWN_MINUTES,
		),
		role: RoleNameSchema.default(DEFAULT_HEALER_ROLE),
		// warren-50a7: routing keys match the alert's fingerprint, culprit, or
		// title with ANCHORED, case-insensitive equality — the whole value must
		// match, not a fragment of it. Widen a key deliberately with `*`, which
		// stands for any run of characters:
		//
		//   "fp-1234"        matches only that exact fingerprint/culprit/title
		//   "src/runs/*"     matches any culprit under src/runs/
		//   "*ErrorRate"     matches any title ending in ErrorRate
		//   "*"              catch-all: every alert routes to this project
		//
		// The old behaviour was an implicit `.includes()` substring test, so a
		// key like "api" claimed every alert whose title merely contained it.
		projectMapping: z
			.array(
				z
					.string()
					.min(1, "healer.projectMapping entries must be non-empty")
					.refine(
						(key) => key.trim() === key,
						"healer.projectMapping entries must not have leading/trailing whitespace",
					),
			)
			.default([]),
	})
	.strict();

export type HealerConfig = z.infer<typeof HealerConfigSchema>;

/**
 * Environment contract for the judge extension (agent-analytics §12).
 *
 * The judge is provider-agnostic: `JUDGE_PROVIDER` / `JUDGE_MODEL` pick the
 * judge model pair, defaulting to anthropic / claude-haiku-4-5, and the pi
 * SDK resolves the matching credential from the per-provider environment
 * variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) — only the configured
 * provider's key is required. Nothing here hardcodes one vendor.
 */

export const DEFAULT_JUDGE_PROVIDER = "anthropic";
export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5";

export interface JudgeConfig {
	readonly warrenBaseUrl: string;
	readonly warrenApiToken: string;
	readonly provider: string;
	readonly model: string;
	/** SQLite store path for verdicts and the poll cursor. */
	readonly dbPath: string;
	/** Delay between terminal-run discovery polls. */
	readonly pollIntervalMs: number;
	/** Per-judgment USD cost cap — the §12.5 analog of `maxCostUsd`. */
	readonly maxCostUsdPerJudgment: number;
	/** Fleet-level daily judge budget; judging skips past it (§12.5). */
	readonly dailyBudgetUsd: number;
}

/** Raised when the environment contract is violated at boot. */
export class ConfigError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

function required(env: Record<string, string | undefined>, name: string): string {
	const value = env[name];
	if (value === undefined || value.length === 0) {
		throw new ConfigError(`missing required environment variable ${name}`);
	}
	return value;
}

function positiveNumber(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new ConfigError(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
	}
	return parsed;
}

/** Resolve the extension config from the process environment. */
export function resolveConfig(env: Record<string, string | undefined>): JudgeConfig {
	return {
		warrenBaseUrl: required(env, "WARREN_BASE_URL").replace(/\/+$/, ""),
		warrenApiToken: required(env, "WARREN_API_TOKEN"),
		provider: env.JUDGE_PROVIDER || DEFAULT_JUDGE_PROVIDER,
		model: env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL,
		dbPath: env.JUDGE_DB_PATH || "./data/judge.db",
		pollIntervalMs: positiveNumber(env, "JUDGE_POLL_INTERVAL_MS", 30_000),
		maxCostUsdPerJudgment: positiveNumber(env, "JUDGE_MAX_COST_USD_PER_JUDGMENT", 0.25),
		dailyBudgetUsd: positiveNumber(env, "JUDGE_DAILY_BUDGET_USD", 5),
	};
}

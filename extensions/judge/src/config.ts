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

/** Default random sample size per calibration pass. */
export const DEFAULT_CALIBRATION_SAMPLE_SIZE = 20;
/** Default cadence between calibration passes: six hours. */
export const DEFAULT_CALIBRATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Default listen port for the export surface (JUDGE_EXPORT_PORT). */
export const DEFAULT_EXPORT_PORT = 8080;

/**
 * The calibration re-judge contract (§12.5): a periodic strong-model pass
 * over a random sample of already-judged runs. Resolved the same way as the
 * cheap judge pair — `JUDGE_CALIBRATION_PROVIDER` / `JUDGE_CALIBRATION_MODEL`,
 * cross-provider capable, with the pi SDK resolving the provider's own
 * credential. Disabled unless `JUDGE_CALIBRATION_MODEL` is set.
 */
export interface CalibrationConfig {
	readonly provider: string;
	readonly model: string;
	/** Random sample size per pass (JUDGE_CALIBRATION_SAMPLE_SIZE). */
	readonly sampleSize: number;
	/** Cadence between passes (JUDGE_CALIBRATION_INTERVAL_MS). */
	readonly intervalMs: number;
}

export interface JudgeConfig {
	readonly warrenBaseUrl: string;
	readonly warrenApiToken: string;
	readonly provider: string;
	readonly model: string;
	/** SQLite store path for verdicts and the poll cursor. */
	readonly dbPath: string;
	/** Delay between terminal-run discovery polls. */
	readonly pollIntervalMs: number;
	/** Per-judgment USD cost cap (JUDGE_MAX_COST_USD) — the §12.5 analog
	 *  of `maxCostUsd`. The legacy JUDGE_MAX_COST_USD_PER_JUDGMENT spelling
	 *  still resolves as a fallback alias. */
	readonly maxCostUsdPerJudgment: number;
	/** Fleet-level daily judge budget; judging skips past it (§12.5). */
	readonly dailyBudgetUsd: number;
	/** Malformed/missing-verdict retries per judgment (judge-loop step). */
	readonly maxRetries: number;
	/** Hard cap on events pages served per judgment; the tail degrades to a
	 *  lower-confidence verdict past it, never unbounded spend. */
	readonly maxPages: number;
	/** Default events page size when the model omits `limit`. */
	readonly eventsPageSize: number;
	/** The strong-model calibration pass, or null when disabled. */
	readonly calibration: CalibrationConfig | null;
	/** Listen port for the export surface (JUDGE_EXPORT_PORT). */
	readonly exportPort: number;
	/**
	 * Static bearer credential gating the export surface
	 * (JUDGE_EXPORT_TOKEN). Null disables the surface entirely — there is
	 * no public projection, so no token means no export.
	 */
	readonly exportToken: string | null;
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
		maxCostUsdPerJudgment:
			env.JUDGE_MAX_COST_USD !== undefined && env.JUDGE_MAX_COST_USD.length > 0
				? positiveNumber(env, "JUDGE_MAX_COST_USD", 0.25)
				: positiveNumber(env, "JUDGE_MAX_COST_USD_PER_JUDGMENT", 0.25),
		dailyBudgetUsd: positiveNumber(env, "JUDGE_DAILY_BUDGET_USD", 5),
		maxRetries: positiveNumber(env, "JUDGE_MAX_RETRIES", 2),
		maxPages: positiveNumber(env, "JUDGE_MAX_PAGES", 40),
		eventsPageSize: positiveNumber(env, "JUDGE_EVENTS_PAGE_SIZE", 200),
		calibration: resolveCalibration(env),
		exportPort: Math.floor(positiveNumber(env, "JUDGE_EXPORT_PORT", DEFAULT_EXPORT_PORT)),
		exportToken:
			env.JUDGE_EXPORT_TOKEN !== undefined && env.JUDGE_EXPORT_TOKEN.length > 0
				? env.JUDGE_EXPORT_TOKEN
				: null,
	};
}

function resolveCalibration(
	env: Record<string, string | undefined>,
): CalibrationConfig | null {
	const model = env.JUDGE_CALIBRATION_MODEL;
	if (model === undefined || model.length === 0) return null;
	return {
		provider: env.JUDGE_CALIBRATION_PROVIDER || env.JUDGE_PROVIDER || DEFAULT_JUDGE_PROVIDER,
		model,
		sampleSize: Math.floor(
			positiveNumber(env, "JUDGE_CALIBRATION_SAMPLE_SIZE", DEFAULT_CALIBRATION_SAMPLE_SIZE),
		),
		intervalMs: positiveNumber(env, "JUDGE_CALIBRATION_INTERVAL_MS", DEFAULT_CALIBRATION_INTERVAL_MS),
	};
}

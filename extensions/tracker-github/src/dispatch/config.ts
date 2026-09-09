import { boolean, type Env, httpUrl, integer, REPOSITORY, required } from "../config.ts";
import { ConfigError } from "../errors.ts";

export interface DispatchConfig {
	readonly enabled: boolean;
	readonly baseUrl: string;
	readonly token: string;
	readonly agent: string;
	readonly projects: Readonly<Record<string, string>>;
	readonly database: string;
	readonly intervalMs: number;
	readonly maxConcurrent: number;
	readonly maxCostUsd: number;
	readonly dailyBudgetUsd: number;
}

function positive(env: Env, name: string): number {
	const value = Number(required(env, name));
	if (!Number.isFinite(value) || value <= 0)
		throw new ConfigError(`${name} must be a positive finite number`);
	return value;
}

/** Merely connecting a tracker never authorizes unattended paid work. */
export function loadDispatchConfig(env: Env): DispatchConfig | undefined {
	if (!boolean(env, "AUTO_DISPATCH_ENABLED")) return undefined;
	required(env, "TRACKER_BEARER");
	let raw: unknown;
	try {
		raw = JSON.parse(required(env, "WARREN_PROJECT_MAP"));
	} catch {
		throw new ConfigError(
			"WARREN_PROJECT_MAP must be a JSON object mapping owner/repo to Warren project id",
		);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		throw new ConfigError("WARREN_PROJECT_MAP must be an object");
	const projects: Record<string, string> = Object.create(null);
	for (const [repo, project] of Object.entries(raw)) {
		if (
			!REPOSITORY.test(repo) ||
			typeof project !== "string" ||
			!/^prj_[a-zA-Z0-9]+$/.test(project) ||
			projects[repo.toLowerCase()]
		)
			throw new ConfigError("WARREN_PROJECT_MAP contains an invalid or duplicate mapping");
		projects[repo.toLowerCase()] = project;
	}
	if (Object.keys(projects).length === 0)
		throw new ConfigError("WARREN_PROJECT_MAP must not be empty");
	const maxCostUsd = positive(env, "AUTO_MAX_COST_USD");
	const dailyBudgetUsd = positive(env, "AUTO_DAILY_BUDGET_USD");
	if (maxCostUsd > dailyBudgetUsd)
		throw new ConfigError("AUTO_MAX_COST_USD must not exceed AUTO_DAILY_BUDGET_USD");
	const database = required(env, "AUTO_STATE_PATH");
	if (database === ":memory:")
		throw new ConfigError("AUTO_STATE_PATH must be a persistent database path");
	return {
		enabled: true,
		baseUrl: httpUrl(required(env, "WARREN_BASE_URL"), "WARREN_BASE_URL"),
		token: required(env, "WARREN_API_TOKEN"),
		agent: required(env, "WARREN_AGENT"),
		projects,
		database,
		intervalMs: integer(env, "AUTO_POLL_SECONDS", 60, 86400) * 1000,
		maxConcurrent: integer(env, "AUTO_MAX_CONCURRENT", 1, 100),
		maxCostUsd,
		dailyBudgetUsd,
	};
}

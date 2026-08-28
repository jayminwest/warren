/**
 * CLI configuration resolution (warren-d050).
 *
 * Configuration comes only from explicit file paths (flags) and named
 * environment variables — never from ambient repository discovery. Secrets
 * (the Warren API token and the GitHub token) enter ONLY through the named
 * environment variables `WARREN_API_TOKEN` and `GITHUB_TOKEN`; passing them
 * as flags is refused so credentials never land in shell history.
 */
import { ConfigError } from "../errors.ts";
import { CliError } from "./exit-codes.ts";

export const ENV_DB_PATH = "CAMPAIGN_DB_PATH";
export const ENV_MANIFEST_PATH = "CAMPAIGN_MANIFEST_PATH";
export const ENV_AMENDMENT_PATH = "CAMPAIGN_AMENDMENT_PATH";
export const ENV_POLICY_PATH = "CAMPAIGN_POLICY_PATH";
export const ENV_BOT_GRAMMAR_PATH = "CAMPAIGN_BOT_GRAMMAR_PATH";
export const ENV_SUMMARIES_PATH = "CAMPAIGN_SUMMARIES_PATH";
export const ENV_WARREN_BASE_URL = "WARREN_BASE_URL";
export const ENV_WARREN_API_TOKEN = "WARREN_API_TOKEN";
export const ENV_GITHUB_TOKEN = "GITHUB_TOKEN";
export const ENV_GITHUB_API_BASE = "GITHUB_API_BASE";

/** Every environment variable the CLI reads. Nothing else is consulted. */
export const READ_ENV_NAMES: readonly string[] = [
	ENV_DB_PATH,
	ENV_MANIFEST_PATH,
	ENV_BOT_GRAMMAR_PATH,
	ENV_POLICY_PATH,
	ENV_SUMMARIES_PATH,
	ENV_WARREN_BASE_URL,
	ENV_WARREN_API_TOKEN,
	ENV_GITHUB_TOKEN,
	ENV_GITHUB_API_BASE,
];

/** The only flags that may carry a secret. (None — secrets are env-only.) */
export const SECRET_FLAGS: readonly string[] = ["warren-token", "github-token", "token"];

export interface CliConfig {
	readonly dbPath: string | null;
	readonly manifestPath: string | null;
	readonly amendmentPath: string | null;
	readonly policyPath: string | null;
	/** Optional review-bot grammar file (warren-8c83); absent = classifier no-ops. */
	readonly botGrammarPath: string | null;
	readonly summariesPath: string | null;
	readonly warrenBaseUrl: string | null;
	readonly githubBaseUrl: string | null;
	readonly warrenToken: string | null;
	readonly githubToken: string | null;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;
export type FlagSource = Readonly<Record<string, string | true>>;

export function resolveConfig(flags: FlagSource, env: EnvSource): CliConfig {
	for (const secretFlag of SECRET_FLAGS) {
		if (secretFlag in flags) {
			throw new CliError(
				`--${secretFlag} is refused: secrets enter only through the ${ENV_WARREN_API_TOKEN} and ${ENV_GITHUB_TOKEN} environment variables`,
			);
		}
	}
	return {
		dbPath: pick(flags.db, env[ENV_DB_PATH]),
		manifestPath: pick(flags.manifest, env[ENV_MANIFEST_PATH]),
		amendmentPath: pick(flags.amendment, env[ENV_AMENDMENT_PATH]),
		policyPath: pick(flags.policy, env[ENV_POLICY_PATH]),
		botGrammarPath: pick(flags.grammar, env[ENV_BOT_GRAMMAR_PATH]),
		summariesPath: pick(flags.summaries, env[ENV_SUMMARIES_PATH]),
		warrenBaseUrl: pick(flags["warren-url"], env[ENV_WARREN_BASE_URL]),
		githubBaseUrl: pick(flags["github-url"], env[ENV_GITHUB_API_BASE]),
		warrenToken: env[ENV_WARREN_API_TOKEN] ?? null,
		githubToken: env[ENV_GITHUB_TOKEN] ?? null,
	};
}

/** The credential values the IO layer must scrub from every line. */
export function secretValues(config: CliConfig): string[] {
	return [config.warrenToken, config.githubToken].filter(
		(value): value is string => value !== null && value.length > 0,
	);
}

function pick(flag: string | true | undefined, envValue: string | undefined): string | null {
	if (flag !== undefined) {
		if (flag === true) {
			throw new CliError("path flags require a value");
		}
		return flag;
	}
	return envValue ?? null;
}

/** Require a path: flag first, then its named env var. */
export function requirePath(
	config: CliConfig,
	key:
		| "manifestPath"
		| "amendmentPath"
		| "policyPath"
		| "summariesPath"
		| "dbPath"
		| "botGrammarPath",
	flagName: string,
	envName: string,
): string {
	const value = config[key];
	if (value === null || value.length === 0) {
		throw new ConfigError(
			`missing ${key.replace(/Path$/, "")} path: pass --${flagName} or set ${envName}`,
		);
	}
	return value;
}

import { ValidationError } from "../core/errors.ts";

export const DEFAULT_WARREN_BASE_URL = "http://localhost:8080";

export interface WarrenClientConfig {
	readonly baseUrl: string;
	readonly token?: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve Warren client configuration from environment variables.
 *
 * Env contract:
 *   WARREN_BASE_URL   base HTTP URL of the Warren server (default: http://localhost:8080)
 *   WARREN_API_TOKEN  bearer token for authenticating API requests
 */
export function loadWarrenClientConfigFromEnv(env: EnvLike = process.env): WarrenClientConfig {
	const baseUrl = env.WARREN_BASE_URL ?? DEFAULT_WARREN_BASE_URL;
	const token = env.WARREN_API_TOKEN;

	if (baseUrl === "") {
		throw new ValidationError("WARREN_BASE_URL is set to an empty string", {
			recoveryHint: `unset WARREN_BASE_URL to fall back to ${DEFAULT_WARREN_BASE_URL}`,
		});
	}

	return token !== undefined && token !== "" ? { baseUrl, token } : { baseUrl };
}

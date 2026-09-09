import { ConfigError } from "./errors.ts";

export type Env = Readonly<Record<string, string | undefined>>;
export interface ProjectScope {
	readonly owner: string;
	readonly ownerType: "organization" | "user";
	readonly number: number;
	readonly statusField: string;
	readonly readyStatuses: readonly string[];
}
export interface GitHubConfig {
	readonly apiUrl: string;
	readonly graphqlUrl: string;
	readonly token?: string;
	readonly tokenFile?: string;
	readonly repository?: string;
	readonly project?: ProjectScope;
	readonly labels: readonly string[];
	readonly labelMode: "all" | "any";
	readonly allowClose: boolean;
	readonly maxPages: number;
	readonly timeoutMs: number;
	readonly port: number;
	readonly bearer?: string;
}

export function required(env: Env, key: string): string {
	const value = env[key]?.trim();
	if (!value) throw new ConfigError(`${key} is required`);
	return value;
}

export function integer(env: Env, key: string, fallback: number, max = 10000): number {
	const raw = env[key];
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be an integer`);
	const n = Number(raw);
	if (!Number.isSafeInteger(n) || n < 1 || n > max) {
		throw new ConfigError(`${key} must be between 1 and ${max}`);
	}
	return n;
}

export function boolean(env: Env, key: string): boolean {
	if (env[key] === undefined || env[key] === "false") return false;
	if (env[key] === "true") return true;
	throw new ConfigError(`${key} must be true or false`);
}

export function strings(env: Env, key: string): string[] {
	if (env[key] === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(env[key]);
	} catch {
		throw new ConfigError(`${key} must be a JSON array of strings`);
	}
	if (!Array.isArray(parsed) || parsed.some((v: unknown) => typeof v !== "string" || !v.trim())) {
		throw new ConfigError(`${key} must be a JSON array of non-empty strings`);
	}
	return [...new Set(parsed as string[])];
}

export function httpUrl(value: string, key: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`${key} must be an absolute URL`);
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new ConfigError(
			`${key} requires HTTPS (HTTP allowed only on loopback), without credentials, query or fragment`,
		);
	}
	return url.href.replace(/\/+$/, "");
}

export const REPOSITORY = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;

function projectConfig(env: Env): ProjectScope | undefined {
	const keys = [
		"GITHUB_PROJECT_OWNER",
		"GITHUB_PROJECT_NUMBER",
		"GITHUB_PROJECT_OWNER_TYPE",
		"GITHUB_PROJECT_STATUS_FIELD",
		"GITHUB_READY_STATUSES",
	];
	if (!keys.some((key) => env[key] !== undefined)) return undefined;
	const owner = required(env, "GITHUB_PROJECT_OWNER");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(owner))
		throw new ConfigError("GITHUB_PROJECT_OWNER is invalid");
	required(env, "GITHUB_PROJECT_NUMBER");
	const ownerType = env.GITHUB_PROJECT_OWNER_TYPE ?? "organization";
	if (ownerType !== "organization" && ownerType !== "user")
		throw new ConfigError("GITHUB_PROJECT_OWNER_TYPE must be organization or user");
	return {
		owner,
		ownerType,
		number: integer(env, "GITHUB_PROJECT_NUMBER", 1, 2147483647),
		statusField:
			env.GITHUB_PROJECT_STATUS_FIELD === undefined
				? "Status"
				: required(env, "GITHUB_PROJECT_STATUS_FIELD"),
		readyStatuses: strings(env, "GITHUB_READY_STATUSES"),
	};
}

export function loadConfig(env: Env): GitHubConfig {
	const apiUrl = httpUrl(env.GITHUB_API_URL ?? "https://api.github.com", "GITHUB_API_URL");
	const graphqlUrl = httpUrl(env.GITHUB_GRAPHQL_URL ?? `${apiUrl}/graphql`, "GITHUB_GRAPHQL_URL");
	if (new URL(apiUrl).origin !== new URL(graphqlUrl).origin)
		throw new ConfigError("GITHUB_GRAPHQL_URL must use the GITHUB_API_URL origin");
	const token = env.GITHUB_TOKEN?.trim();
	const tokenFile = env.GITHUB_TOKEN_FILE?.trim();
	if (Boolean(token) === Boolean(tokenFile))
		throw new ConfigError("set exactly one of GITHUB_TOKEN or GITHUB_TOKEN_FILE");
	const repository = env.GITHUB_REPOSITORY;
	if (repository !== undefined && !REPOSITORY.test(repository))
		throw new ConfigError("GITHUB_REPOSITORY must be owner/repo");
	const project = projectConfig(env);
	if (!repository && !project)
		throw new ConfigError("configure GITHUB_REPOSITORY or a GitHub Project scope");
	const labelMode = env.GITHUB_LABEL_MODE ?? "all";
	if (labelMode !== "all" && labelMode !== "any")
		throw new ConfigError("GITHUB_LABEL_MODE must be all or any");
	return {
		apiUrl,
		graphqlUrl,
		token,
		tokenFile,
		repository,
		project,
		labelMode,
		labels: strings(env, "GITHUB_LABELS"),
		allowClose: boolean(env, "GITHUB_ALLOW_CLOSE"),
		maxPages: integer(env, "GITHUB_MAX_PAGES", 100),
		timeoutMs: integer(env, "GITHUB_TIMEOUT_MS", 15000, 120000),
		port: integer(env, "TRACKER_PORT", 8080, 65535),
		bearer: env.TRACKER_BEARER,
	};
}

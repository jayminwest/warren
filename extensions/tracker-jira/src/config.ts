/**
 * Configuration, read once from the environment at boot.
 *
 * The credential posture is the one the protocol asks for
 * (docs/design/issue-tracker.md §5): this container holds the Jira
 * credential and warren stores none. `TRACKER_BEARER` is the other
 * direction, the token warren must present to this server, and it is
 * unrelated to the Jira one.
 *
 * Every miss fails loud at boot and names the variable. A tracker that
 * starts unconfigured turns into a confusing upstream error three layers
 * away, inside a run, which is the worst place to read it.
 */

/** How this container authenticates to Jira. */
export type JiraAuth =
	| { readonly kind: "basic"; readonly email: string; readonly apiToken: string }
	| { readonly kind: "bearer"; readonly token: string };

export interface JiraTrackerConfig {
	/** Jira Cloud site root, no trailing slash: `https://acme.atlassian.net`. */
	readonly baseUrl: string;
	readonly auth: JiraAuth;
	/** The query that decides which issues warren sees at all. */
	readonly jql: string;
	/** Transition name used to close. Unset picks the first `done`-category one. */
	readonly doneTransition?: string;
	/** The inward link description Jira uses for a blocking relationship. */
	readonly blockedByInward: string;
	readonly port: number;
	/** The bearer warren must present to THIS server. Unset means no auth. */
	readonly bearerToken?: string;
	/** Issues per search page. Jira caps this server-side anyway. */
	readonly searchPageSize: number;
	/** Hard stop on search pagination, so a runaway query cannot loop forever. */
	readonly maxSearchPages: number;
}

export class ConfigError extends Error {}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = env[name];
	if (value === undefined || value.trim() === "") {
		throw new ConfigError(`${name} is required`);
	}
	return value.trim();
}

function optional(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
): string | undefined {
	const value = env[name];
	if (value === undefined || value.trim() === "") return undefined;
	return value.trim();
}

function positiveInt(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	fallback: number,
): number {
	const raw = optional(env, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new ConfigError(`${name} must be a positive whole number, got "${raw}"`);
	}
	return value;
}

/**
 * Basic with an Atlassian account email plus an API token is the
 * documented Jira Cloud path. `JIRA_BEARER` covers a setup that issues an
 * OAuth access token instead. Configuring both is a mistake worth naming
 * rather than resolving by precedence.
 */
function resolveAuth(env: Readonly<Record<string, string | undefined>>): JiraAuth {
	const bearer = optional(env, "JIRA_BEARER");
	const email = optional(env, "JIRA_EMAIL");
	const apiToken = optional(env, "JIRA_API_TOKEN");
	if (bearer !== undefined && (email !== undefined || apiToken !== undefined)) {
		throw new ConfigError("set either JIRA_BEARER or JIRA_EMAIL + JIRA_API_TOKEN, not both");
	}
	if (bearer !== undefined) return { kind: "bearer", token: bearer };
	if (email === undefined || apiToken === undefined) {
		throw new ConfigError("JIRA_EMAIL and JIRA_API_TOKEN are required (or JIRA_BEARER instead)");
	}
	return { kind: "basic", email, apiToken };
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): JiraTrackerConfig {
	const baseUrl = required(env, "JIRA_BASE_URL").replace(/\/+$/, "");
	if (!/^https?:\/\//.test(baseUrl)) {
		throw new ConfigError(`JIRA_BASE_URL must be an http(s) URL, got "${baseUrl}"`);
	}
	const doneTransition = optional(env, "JIRA_DONE_TRANSITION");
	const bearerToken = optional(env, "TRACKER_BEARER");
	return {
		baseUrl,
		auth: resolveAuth(env),
		jql: required(env, "JIRA_JQL"),
		...(doneTransition !== undefined ? { doneTransition } : {}),
		blockedByInward: optional(env, "JIRA_BLOCKED_BY_INWARD") ?? "is blocked by",
		port: positiveInt(env, "TRACKER_PORT", 8080),
		...(bearerToken !== undefined ? { bearerToken } : {}),
		searchPageSize: positiveInt(env, "JIRA_SEARCH_PAGE_SIZE", 100),
		maxSearchPages: positiveInt(env, "JIRA_MAX_SEARCH_PAGES", 50),
	};
}

/** The `Authorization` header value this container sends to Jira. */
export function jiraAuthHeader(auth: JiraAuth): string {
	if (auth.kind === "bearer") return `Bearer ${auth.token}`;
	return `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64")}`;
}

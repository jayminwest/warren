/**
 * Configuration, read once from the environment at boot.
 *
 * The credential posture is the one the protocol asks for
 * (docs/design/issue-tracker.md §5): this container holds the Azure
 * DevOps credential and warren stores none. `TRACKER_BEARER` is the other
 * direction, the token warren must present to this server, and it is
 * unrelated to the Azure DevOps one.
 *
 * Every miss fails loud at boot and names the variable. A tracker that
 * starts unconfigured turns into a confusing upstream error three layers
 * away, inside a run, which is the worst place to read it.
 */

/** How this container authenticates to Azure DevOps. */
export type AdoAuth =
	| { readonly kind: "pat"; readonly token: string }
	| { readonly kind: "bearer"; readonly token: string };

/** Azure DevOps caps a work-items batch read at 200 ids per call. */
const ADO_MAX_BATCH_SIZE = 200;

const MAX_PORT = 65535;

export interface AdoTrackerConfig {
	/** Organization root, no trailing slash: `https://dev.azure.com/acme`. */
	readonly orgUrl: string;
	/** Team project name or id. Every work-item route is scoped to it. */
	readonly project: string;
	readonly auth: AdoAuth;
	/**
	 * The WIQL query behind the status map, which is the list warren
	 * claims work from. A read or close of a specific id does not consult
	 * it: the access boundary is the credential and the project.
	 */
	readonly wiql: string;
	/** State name set on close. Unset picks the first `Completed`-category state. */
	readonly doneState?: string;
	/** The link type whose target is the work item blocking this one. */
	readonly blockedByLink: string;
	readonly port: number;
	/** The bearer warren must present to THIS server. Unset means no auth. */
	readonly bearerToken?: string;
	/** Ids per batch read. Azure DevOps refuses more than 200. */
	readonly batchSize: number;
	/** Hard stop on the WIQL result count, so a runaway query fails loud. */
	readonly maxWiqlResults: number;
	/** Deadline per Azure DevOps call, headers and body included. */
	readonly timeoutMs: number;
}

/**
 * Long enough for a 200-id batch read on a slow day, short enough that a
 * stalled connection cannot hold a warren request open for minutes.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

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
	max = Number.MAX_SAFE_INTEGER,
): number {
	const raw = optional(env, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new ConfigError(`${name} must be a positive whole number, got "${raw}"`);
	}
	if (value > max) throw new ConfigError(`${name} must be at most ${max}, got ${value}`);
	return value;
}

/**
 * The organization root, as the client will prefix every path with it.
 * Azure DevOps is https only. Credentials belong in `ADO_PAT` or
 * `ADO_BEARER`, and a query or fragment could never survive the paths
 * appended after it, so each of those is a misconfiguration named at
 * boot rather than a request that fails later in a shape hard to read.
 */
function organizationUrl(env: Readonly<Record<string, string | undefined>>): string {
	const raw = required(env, "ADO_ORG_URL");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError("ADO_ORG_URL must be an https URL");
	}
	// Credentials are checked before anything from the value is echoed,
	// so a token pasted into the URL never reaches the boot log.
	if (url.username !== "" || url.password !== "") {
		throw new ConfigError("ADO_ORG_URL must not carry credentials; set ADO_PAT or ADO_BEARER");
	}
	if (url.protocol !== "https:") {
		throw new ConfigError(`ADO_ORG_URL must be an https URL, got scheme "${url.protocol}"`);
	}
	// The query and fragment are not echoed either: `?token=...` is a
	// credential spelling just like userinfo.
	if (url.search !== "" || url.hash !== "") {
		const part = url.search !== "" ? "a query" : "a fragment";
		throw new ConfigError(`ADO_ORG_URL must not carry a query or fragment; found ${part}`);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * A personal access token is the documented Azure DevOps path and goes
 * over basic auth with an empty user name. `ADO_BEARER` covers a setup
 * that already mints an Entra ID access token; it is read once and never
 * refreshed, so an expired one means a restart. Configuring both is a
 * mistake worth naming rather than resolving by precedence.
 */
function resolveAuth(env: Readonly<Record<string, string | undefined>>): AdoAuth {
	const bearer = optional(env, "ADO_BEARER");
	const pat = optional(env, "ADO_PAT");
	if (bearer !== undefined && pat !== undefined) {
		throw new ConfigError("set either ADO_PAT or ADO_BEARER, not both");
	}
	if (bearer !== undefined) return { kind: "bearer", token: bearer };
	if (pat === undefined) {
		throw new ConfigError("ADO_PAT is required (or ADO_BEARER instead)");
	}
	return { kind: "pat", token: pat };
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): AdoTrackerConfig {
	const doneState = optional(env, "ADO_DONE_STATE");
	const bearerToken = optional(env, "TRACKER_BEARER");
	return {
		orgUrl: organizationUrl(env),
		project: required(env, "ADO_PROJECT"),
		auth: resolveAuth(env),
		wiql: required(env, "ADO_WIQL"),
		...(doneState !== undefined ? { doneState } : {}),
		blockedByLink: optional(env, "ADO_BLOCKED_BY_LINK") ?? "System.LinkTypes.Dependency-Reverse",
		port: positiveInt(env, "TRACKER_PORT", 8080, MAX_PORT),
		...(bearerToken !== undefined ? { bearerToken } : {}),
		batchSize: positiveInt(env, "ADO_BATCH_SIZE", ADO_MAX_BATCH_SIZE, ADO_MAX_BATCH_SIZE),
		maxWiqlResults: positiveInt(env, "ADO_MAX_WIQL_RESULTS", 5000),
		timeoutMs: positiveInt(env, "ADO_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
	};
}

/** The `Authorization` header value this container sends to Azure DevOps. */
export function adoAuthHeader(auth: AdoAuth): string {
	if (auth.kind === "bearer") return `Bearer ${auth.token}`;
	return `Basic ${Buffer.from(`:${auth.token}`).toString("base64")}`;
}

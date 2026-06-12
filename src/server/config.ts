/**
 * Resolve the warren HTTP server's environment-driven config (SPEC §10).
 *
 * Five pieces of state matter here:
 *   1. Where the server binds (host + port; or unix socket path).
 *   2. Which database backend warren opens (WARREN_DB_URL contract).
 *   3. The bearer token that protects every route except /healthz.
 *   4. Where the UI's static dist dir is (`src/ui/dist` in dev, `/app/src/ui/dist` in container).
 *   5. The data dir root (joined for default db path).
 *
 * Env contract (all warren-namespaced):
 *   WARREN_API_TOKEN         bearer token — required (or pass --no-auth)
 *   WARREN_BIND_HOST         TCP host — defaults to 0.0.0.0
 *   WARREN_BIND_PORT         TCP port — defaults to 8080
 *   WARREN_BIND_SOCKET       unix socket path — presence flips transport to unix
 *   WARREN_DATA_DIR          data root — defaults to /data
 *   WARREN_DB_URL            dialect-aware database URL (sqlite:/// or postgres://)
 *   WARREN_DB_PATH           legacy SQLite path; back-compat alias for WARREN_DB_URL
 *   WARREN_UI_DIST_DIR       UI dist dir — defaults to <repo>/src/ui/dist
 *   WARREN_DISABLE_UI        1/true/yes/on (case-insensitive) to disable static UI serving entirely
 *
 * `dbUrl` precedence (R-13 pl-f17e step 5, warren-e2ea): WARREN_DB_URL
 * wins; else WARREN_DB_PATH is synthesized into a sqlite:// URL; else
 * `<DATA_DIR>/warren.db` is synthesized. When both URL and PATH are set
 * and they disagree, `dbUrlConflict` carries the legacy value so
 * `bootServer` can log a warning (the loader itself stays pure).
 *
 * Other configs (canopy, projects, burrow client) load from their own
 * env-readers — this loader only handles server-process concerns.
 */

import { join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import { sqliteUrlForPath } from "../db/url.ts";
import { parseTrueEnv } from "./main/utils.ts";
import type { Transport } from "./types.ts";

export const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_BIND_HOST = "0.0.0.0";
export const DEFAULT_BIND_PORT = 8080;

export interface ServerConfig {
	readonly transport: Transport;
	readonly token: string | null;
	/** WARREN_DB_URL contract (R-13). May be a sqlite or postgres URL. */
	readonly dbUrl: string;
	/**
	 * Carries the legacy WARREN_DB_PATH value when it disagrees with an
	 * explicit WARREN_DB_URL. `bootServer` logs a warning; the loader itself
	 * stays pure. `null` when there is no conflict.
	 */
	readonly dbUrlConflict: string | null;
	readonly dataDir: string;
	readonly uiDistDir: string | null;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface LoadServerConfigOptions {
	readonly env?: EnvLike;
	/** Skip token requirement (CLI `--no-auth`). */
	readonly noAuth?: boolean;
	/** Default UI dist directory. Falls back to `<cwd>/src/ui/dist`. */
	readonly defaultUiDistDir?: string;
}

export function loadServerConfigFromEnv(opts: LoadServerConfigOptions = {}): ServerConfig {
	const env = opts.env ?? process.env;

	const transport = resolveTransport(env);
	const token = resolveToken(env, opts.noAuth ?? false);
	const dataDir = env.WARREN_DATA_DIR ?? DEFAULT_DATA_DIR;
	const { dbUrl, dbUrlConflict } = resolveDbUrl(env, dataDir);
	const uiDistDir = resolveUiDistDir(env, opts.defaultUiDistDir);

	return { transport, token, dbUrl, dbUrlConflict, dataDir, uiDistDir };
}

interface ResolvedDbUrl {
	readonly dbUrl: string;
	readonly dbUrlConflict: string | null;
}

function resolveDbUrl(env: EnvLike, dataDir: string): ResolvedDbUrl {
	const url = env.WARREN_DB_URL;
	const path = env.WARREN_DB_PATH;
	if (url !== undefined && url !== "") {
		const conflict =
			path !== undefined && path !== "" && sqliteUrlForPath(path) !== url ? path : null;
		return { dbUrl: url, dbUrlConflict: conflict };
	}
	if (path !== undefined && path !== "") {
		return { dbUrl: sqliteUrlForPath(path), dbUrlConflict: null };
	}
	return { dbUrl: sqliteUrlForPath(join(dataDir, "warren.db")), dbUrlConflict: null };
}

function resolveTransport(env: EnvLike): Transport {
	const socket = env.WARREN_BIND_SOCKET;
	if (socket !== undefined && socket !== "") {
		return { kind: "unix", path: socket };
	}
	const host = env.WARREN_BIND_HOST ?? DEFAULT_BIND_HOST;
	const portRaw = env.WARREN_BIND_PORT;
	const port =
		portRaw !== undefined && portRaw !== "" ? Number.parseInt(portRaw, 10) : DEFAULT_BIND_PORT;
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new ValidationError(
			`WARREN_BIND_PORT must be an integer 0..65535 (got ${JSON.stringify(portRaw)})`,
		);
	}
	return { kind: "tcp", hostname: host, port };
}

function resolveToken(env: EnvLike, noAuth: boolean): string | null {
	if (noAuth) return null;
	const token = env.WARREN_API_TOKEN;
	if (token === undefined || token === "") {
		throw new ValidationError("WARREN_API_TOKEN is not set", {
			recoveryHint: "export WARREN_API_TOKEN=<token> or boot with --no-auth (loopback only)",
		});
	}
	return token;
}

function resolveUiDistDir(env: EnvLike, fallback: string | undefined): string | null {
	const explicit = env.WARREN_UI_DIST_DIR;
	if (parseTrueEnv(env.WARREN_DISABLE_UI)) return null;
	if (explicit !== undefined && explicit !== "") return explicit;
	return fallback ?? join(process.cwd(), "src", "ui", "dist");
}

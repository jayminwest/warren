/**
 * On-disk client config file (warren-fc12, owner decision D5).
 *
 * `warren login` persists base URL + token ONLY — never a DB credential —
 * to `${WARREN_CLIENT_CONFIG ?? ~/.warren/client.json}`, written mode
 * 0600. Resolution precedence across the CLI is
 *
 *   --url / --token flags  >  WARREN_BASE_URL / WARREN_API_TOKEN env  >  this file  >  built-in default
 *
 * File I/O lives in its own module (not `config.ts`) so the env-only
 * loader stays free of `node:fs` for browser-bundled consumers.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import type { EnvLike, WarrenClientConfig } from "./config.ts";

/** Env var that overrides the on-disk client config location (tests, agents). */
export const CLIENT_CONFIG_PATH_ENV = "WARREN_CLIENT_CONFIG";

const FILE_MODE = 0o600;

/** Resolve the client config path: `WARREN_CLIENT_CONFIG` or `~/.warren/client.json`. */
export function clientConfigPath(env: EnvLike = process.env): string {
	const override = env[CLIENT_CONFIG_PATH_ENV];
	if (override !== undefined && override !== "") return override;
	return join(homedir(), ".warren", "client.json");
}

/**
 * Load the persisted client config, or `undefined` when no file exists.
 * A present-but-unparseable file is a validation error — silently falling
 * through to the default would mask a typo the operator meant to apply.
 */
export function loadWarrenClientConfigFromFile(
	env: EnvLike = process.env,
): WarrenClientConfig | undefined {
	const path = clientConfigPath(env);
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new ValidationError(`client config file ${path} is not valid JSON`, {
			recoveryHint: "fix the file or re-run `warren login` to rewrite it",
		});
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new ValidationError(`client config file ${path} must hold a JSON object`, {
			recoveryHint: "re-run `warren login` to rewrite it",
		});
	}
	const record = parsed as Record<string, unknown>;
	const baseUrl = record.baseUrl;
	if (typeof baseUrl !== "string" || baseUrl === "") {
		throw new ValidationError(`client config file ${path} is missing a string "baseUrl"`, {
			recoveryHint: "re-run `warren login --url <base>` to rewrite it",
		});
	}
	// Trim the token on load (warren-c550): a hand-edited file with a
	// trailing newline or space would otherwise produce a standalone
	// `[unauthorized] invalid bearer token` — the credential visibly
	// exists on disk, but every request carries the wrong bytes.
	const token = record.token;
	if (typeof token === "string") {
		const trimmed = token.trim();
		return trimmed !== "" ? { baseUrl, token: trimmed } : { baseUrl };
	}
	return { baseUrl };
}

/**
 * Persist the client config with owner-only permissions. The parent
 * directory is created on demand. The token is a credential: never echo
 * it to logs, and never commit this file (it lives under $HOME, outside
 * any repo).
 */
export function saveWarrenClientConfigToFile(
	config: WarrenClientConfig,
	env: EnvLike = process.env,
): string {
	const path = clientConfigPath(env);
	mkdirSync(dirname(path), { recursive: true });
	const body =
		config.token !== undefined
			? { baseUrl: config.baseUrl, token: config.token }
			: { baseUrl: config.baseUrl };
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: FILE_MODE });
	// writeFileSync mode only applies on create; chmod unconditionally so a
	// pre-existing world-readable file is tightened too.
	chmodSync(path, FILE_MODE);
	return path;
}

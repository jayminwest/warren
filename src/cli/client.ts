/**
 * Shared remote-server resolution for the HTTP-collapsed CLI (warren-97a2,
 * owner decisions D3 + D5).
 *
 * Every remote-capable command (`run`, `add-project`, `doctor`, `init`,
 * `config migrate`, the `plan` group) resolves its server the same way:
 * base URL + token ONLY (D5 — never a DB credential), with precedence
 *
 *   --url / --token flags  >  WARREN_BASE_URL / WARREN_API_TOKEN env  >  config file  >  built-in default
 *
 * The config file slot (warren-fc12) is what `warren login` writes. The
 * env half of the contract lives in `src/client/config.ts`
 * (`loadWarrenClientConfigFromEnv`), the file half in
 * `src/client/config-file.ts`; this module adds the flag override and
 * the merge so command files never hand-roll it.
 */

import type { Command } from "commander";
import { loadWarrenClientConfigFromFile } from "../client/config-file.ts";
import {
	loadWarrenClientConfigFromEnv,
	WarrenClient,
	type WarrenClientConfig,
} from "../client/index.ts";
import type { EnvLike } from "./output.ts";

/** The `--url` / `--token` flag pair every remote command accepts. */
export interface ClientFlags {
	readonly url?: string;
	readonly token?: string;
}

/** The shape commander hands back for the client flag pair. */
export interface RemoteOpts {
	readonly url?: string;
	readonly token?: string;
}

/** The `--url` / `--token` flag pair every remote command declares (D5). */
export function addClientFlags(cmd: Command): Command {
	return cmd
		.option("--url <url>", "warren server base URL (env WARREN_BASE_URL)")
		.option("--token <token>", "bearer token (env WARREN_API_TOKEN)");
}

/** Narrow parsed commander opts into {@link ClientFlags}, dropping unset keys. */
export function clientFlags(opts: RemoteOpts): ClientFlags {
	return {
		...(opts.url !== undefined ? { url: opts.url } : {}),
		...(opts.token !== undefined ? { token: opts.token } : {}),
	};
}

/**
 * Resolve a {@link WarrenClient} for this invocation. Empty-string flags
 * are treated as unset so `--url ""` can't clobber a good env value.
 */
export function resolveWarrenClient(env: EnvLike, flags: ClientFlags = {}): WarrenClient {
	return new WarrenClient({ config: resolveClientConfig(env, flags) });
}

/**
 * Resolve the merged client config (base URL + token) without building a
 * client: flags > env > config file > built-in default. Empty-string
 * flags are treated as unset so `--url ""` can't clobber a good value.
 * Exported for `warren login`, which needs the pre-save merge.
 */
export function resolveClientConfig(env: EnvLike, flags: ClientFlags = {}): WarrenClientConfig {
	const fromEnv = loadWarrenClientConfigFromEnv(env);
	const fromFile = loadWarrenClientConfigFromFile(env);
	const envUrl = env.WARREN_BASE_URL;
	const envToken = env.WARREN_API_TOKEN;
	const baseUrl = firstNonEmpty(flags.url, envUrl, fromFile?.baseUrl) ?? fromEnv.baseUrl;
	const token = firstNonEmpty(flags.token, envToken, fromFile?.token);
	return token !== undefined ? { baseUrl, token } : { baseUrl };
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
	for (const value of values) {
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

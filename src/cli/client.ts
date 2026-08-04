/**
 * Shared remote-server resolution for the HTTP-collapsed CLI (warren-97a2,
 * owner decisions D3 + D5).
 *
 * Every remote-capable command (`run`, `add-project`, `doctor`, `init`,
 * `config migrate`, the `plan` group) resolves its server the same way:
 * base URL + token ONLY (D5 — never a DB credential), with precedence
 *
 *   --url / --token flags  >  WARREN_BASE_URL / WARREN_API_TOKEN env  >  built-in default
 *
 * (A config file slot lands with `warren login`, warren-fc12, between
 * flags and env.) The env half of the contract lives in
 * `src/client/config.ts` (`loadWarrenClientConfigFromEnv`); this module
 * adds the flag override so command files never hand-roll the merge.
 */

import type { Command } from "commander";
import { loadWarrenClientConfigFromEnv, WarrenClient } from "../client/index.ts";
import type { EnvLike } from "./output.ts";

/** The `--url` / `--token` flag pair every remote command accepts. */
export interface ClientFlags {
	readonly url?: string;
	readonly token?: string;
}

/** The remote flags every remote-capable commander action receives. */
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

/** Pluck the {@link ClientFlags} pair out of a parsed commander opts bag. */
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
	const fromEnv = loadWarrenClientConfigFromEnv(env);
	const baseUrl = flags.url !== undefined && flags.url !== "" ? flags.url : fromEnv.baseUrl;
	const token = flags.token !== undefined && flags.token !== "" ? flags.token : fromEnv.token;
	return new WarrenClient({ config: token !== undefined ? { baseUrl, token } : { baseUrl } });
}

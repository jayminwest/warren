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

/** Which slot supplied a resolved value (warren-8807). */
export type ClientConfigSource = "flag" | "env" | "config-file" | "default";

/** A merged client config plus the slot each half was taken from. */
export interface ResolvedClientConfig {
	readonly config: WarrenClientConfig;
	readonly baseUrlSource: ClientConfigSource;
	/** Absent when no slot carried a token at all. */
	readonly tokenSource?: ClientConfigSource;
}

/**
 * Resolve a {@link WarrenClient} for this invocation. Empty-string flags
 * are treated as unset so `--url ""` can't clobber a good env value.
 */
export function resolveWarrenClient(env: EnvLike, flags: ClientFlags = {}): WarrenClient {
	return resolveWarrenClientWithSources(env, flags).client;
}

/** A resolved client plus the slot each half of its config came from. */
export interface ResolvedWarrenClient {
	readonly client: WarrenClient;
	readonly baseUrlSource: ClientConfigSource;
	readonly tokenSource?: ClientConfigSource;
}

/**
 * Resolve a client and keep the slots, for commands that have to report
 * which credential they sent. `warren doctor` is the caller (warren-8807).
 */
export function resolveWarrenClientWithSources(
	env: EnvLike,
	flags: ClientFlags = {},
): ResolvedWarrenClient {
	const resolved = resolveClientConfigWithSources(env, flags);
	const client = new WarrenClient({ config: resolved.config });
	return resolved.tokenSource !== undefined
		? { client, baseUrlSource: resolved.baseUrlSource, tokenSource: resolved.tokenSource }
		: { client, baseUrlSource: resolved.baseUrlSource };
}

/**
 * Resolve the merged client config (base URL + token) without building a
 * client: flags > env > config file > built-in default. Empty-string
 * flags are treated as unset so `--url ""` can't clobber a good value.
 * Exported for `warren login`, which needs the pre-save merge.
 */
export function resolveClientConfig(env: EnvLike, flags: ClientFlags = {}): WarrenClientConfig {
	return resolveClientConfigWithSources(env, flags).config;
}

/**
 * The same merge, plus the slot each value came from, for commands that
 * have to explain WHICH credential they sent (warren-8807). The precedence
 * itself is unchanged.
 *
 * A cwd `.env` is indistinguishable from a real environment variable here:
 * Bun loads it before the process starts, so both report `env`. That is
 * still the answer that explains an `[unauthorized]` right after a
 * successful `warren login`.
 */
export function resolveClientConfigWithSources(
	env: EnvLike,
	flags: ClientFlags = {},
): ResolvedClientConfig {
	const fromEnv = loadWarrenClientConfigFromEnv(env);
	const fromFile = loadWarrenClientConfigFromFile(env);
	const baseUrl = firstNonEmpty(
		{ source: "flag", value: flags.url },
		{ source: "env", value: env.WARREN_BASE_URL },
		{ source: "config-file", value: fromFile?.baseUrl },
	);
	const token = firstNonEmpty(
		{ source: "flag", value: flags.token },
		{ source: "env", value: env.WARREN_API_TOKEN },
		{ source: "config-file", value: fromFile?.token },
	);
	const resolvedBaseUrl = baseUrl?.value ?? fromEnv.baseUrl;
	const baseUrlSource = baseUrl?.source ?? "default";
	return token !== undefined
		? {
				config: { baseUrl: resolvedBaseUrl, token: token.value },
				baseUrlSource,
				tokenSource: token.source,
			}
		: { config: { baseUrl: resolvedBaseUrl }, baseUrlSource };
}

/** One candidate slot for a resolved value, in precedence order. */
interface ConfigCandidate {
	readonly source: ClientConfigSource;
	readonly value: string | undefined;
}

/** The first candidate that carries a value; empty strings count as unset. */
function firstNonEmpty(
	...candidates: readonly ConfigCandidate[]
): { readonly source: ClientConfigSource; readonly value: string } | undefined {
	for (const candidate of candidates) {
		if (candidate.value !== undefined && candidate.value !== "") {
			return { source: candidate.source, value: candidate.value };
		}
	}
	return undefined;
}

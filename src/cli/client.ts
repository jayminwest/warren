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
import { DEFAULT_WARREN_BASE_URL, WarrenClient, type WarrenClientConfig } from "../client/index.ts";
import { ValidationError } from "../core/errors.ts";
import type { CliContext, EnvLike } from "./output.ts";

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

/** A resolved client plus the context that remembers where its token came from. */
export interface CommandClient {
	readonly client: WarrenClient;
	readonly context: CliContext;
}

/**
 * Resolve the client for one command invocation, and hand back a context
 * that carries the slot the token came from (warren-2d4c). Every remote
 * command resolves through here, so the shared catch-tail
 * (`commandFailure`) can blame the slot that actually supplied the rejected
 * credential rather than guessing at `WARREN_API_TOKEN`.
 *
 * The context is returned rather than mutated because `CliContext` is
 * readonly and one program builds many of them, one per invocation.
 */
export function resolveCommandClient(context: CliContext, opts: RemoteOpts): CommandClient {
	const resolved = resolveWarrenClientWithSources(context.env, clientFlags(opts));
	return {
		client: resolved.client,
		context:
			resolved.tokenSource !== undefined
				? { ...context, tokenSource: resolved.tokenSource }
				: context,
	};
}

/** A resolved client plus the slot each half of its config came from. */
export interface ResolvedWarrenClient {
	readonly client: WarrenClient;
	readonly baseUrlSource: ClientConfigSource;
	readonly tokenSource?: ClientConfigSource;
}

/**
 * Resolve a client and keep the slots, for callers that have to report
 * which credential they sent (warren-8807). `warren doctor` reads both
 * halves; {@link resolveCommandClient} wraps this for every other command.
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
 * An `env` source can only be a genuinely exported variable: the
 * `main.ts` shebang passes `--env-file=/dev/null`, so Bun never folds a
 * cwd `.env` into `process.env` (warren-8807, closed structurally).
 */
export function resolveClientConfigWithSources(
	env: EnvLike,
	flags: ClientFlags = {},
): ResolvedClientConfig {
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

	if (baseUrl === undefined && env.WARREN_BASE_URL === "") {
		throw new ValidationError("WARREN_BASE_URL is set to an empty string", {
			recoveryHint: `unset WARREN_BASE_URL to fall back to ${DEFAULT_WARREN_BASE_URL}`,
		});
	}

	const resolvedBaseUrl = baseUrl?.value ?? DEFAULT_WARREN_BASE_URL;
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

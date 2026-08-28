/**
 * `warren login` — agent session bootstrap, half one (warren-fc12,
 * pl-882c step 11, owner decision D5).
 *
 * Verifies a base URL + token against `GET /whoami`, then persists the
 * pair to the client config file (`src/client/config-file.ts`) so later
 * invocations resolve the server without flags or env. The file holds
 * base URL + token ONLY — never a DB credential.
 *
 * Token source precedence: `--token` flag > piped stdin >
 * `WARREN_API_TOKEN` env. An explicitly piped stdin token wins over an
 * ambient env token (warren-2244): the operator typed that credential
 * deliberately, while the env value merely rode along in the shell.
 * (A cwd `.env` never reaches the CLI at all — the `main.ts` shebang
 * passes `--env-file=/dev/null`, closing warren-8807.) This login-local
 * precedence overrides the global flag > env > file order only when
 * stdin actually carries a token — every other command keeps the
 * documented global precedence. The stdin arm exists so an interactive
 * operator keeps the credential out of shell history. The token is
 * NEVER echoed back — the emitted result carries its length and a
 * masked prefix only.
 */

import { saveWarrenClientConfigToFile } from "../../client/config-file.ts";
import type { WarrenClient, WarrenClientConfig } from "../../client/index.ts";
import { type CliContext, commandFailure, writeResult } from "../output.ts";

export interface LoginArgs {
	/** Base URL override; falls through env → config file → default. */
	readonly url?: string;
	/** Token override; falls through env → stdin. */
	readonly token?: string;
}

export interface LoginDeps {
	/** Pre-save merge (flags > env > file > default), shared with every command. */
	readonly resolveConfig: (args: LoginArgs) => WarrenClientConfig;
	/** Build a client for the verification probe. */
	readonly makeClient: (config: WarrenClientConfig) => Pick<WarrenClient, "whoami">;
	/** Read the token from stdin (operator typed it interactively). */
	readonly readTokenFromStdin: () => Promise<string>;
	/** Persist the verified config; returns the path written. */
	readonly saveConfig?: (config: WarrenClientConfig) => string;
}

export interface LoginResult {
	readonly exitCode: number;
}

export async function runLogin(
	context: CliContext,
	deps: LoginDeps,
	args: LoginArgs,
): Promise<LoginResult> {
	try {
		const base = deps.resolveConfig({ url: args.url, token: args.token });
		const token = await resolveToken(context, deps, args);
		if (token === undefined) {
			context.stdio.stderr.write(
				"warren: no token supplied — pass --token, set WARREN_API_TOKEN, or pipe it on stdin\n",
			);
			return { exitCode: 2 };
		}
		const config: WarrenClientConfig = { baseUrl: base.baseUrl, token };

		const who = await deps.makeClient(config).whoami();
		const save =
			deps.saveConfig ?? ((c: WarrenClientConfig) => saveWarrenClientConfigToFile(c, context.env));
		const path = save(config);

		const pretty = `✔ logged in to ${config.baseUrl} as ${who.identity} (config: ${path}, token ${maskToken(token)})`;
		writeResult(
			context,
			{
				command: "login",
				ok: true,
				baseUrl: config.baseUrl,
				identity: who.identity,
				capabilities: who.capabilities,
				configPath: path,
				tokenLength: token.length,
			},
			pretty,
		);
		return { exitCode: 0 };
	} catch (err) {
		return commandFailure(context, err);
	}
}

async function resolveToken(
	context: CliContext,
	deps: LoginDeps,
	args: LoginArgs,
): Promise<string | undefined> {
	if (args.token !== undefined && args.token !== "") return args.token;
	// Piped stdin outranks a merely ambient env token (warren-2244). A TTY
	// stdin yields "" instantly, so an interactive run with no env still
	// fails fast instead of blocking.
	const fromStdin = (await deps.readTokenFromStdin()).trim();
	const fromEnv = context.env.WARREN_API_TOKEN;
	if (fromStdin !== "") {
		if (fromEnv !== undefined && fromEnv !== "" && fromEnv !== fromStdin) {
			context.stdio.stderr.write(
				"warren: using token piped on stdin; ignoring WARREN_API_TOKEN from environment " +
					"(unset it to silence this warning)\n",
			);
		}
		return fromStdin;
	}
	return fromEnv !== "" ? fromEnv : undefined;
}

/** Mask a token for display: first 4 chars + bullet run, never the full value. */
function maskToken(token: string): string {
	return `${token.slice(0, 4)}••••`;
}

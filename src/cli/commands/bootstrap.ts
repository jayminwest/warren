/**
 * Session-bootstrap command registration (warren-fc12, pl-882c step 11).
 *
 * Extracted from `main.ts` to keep that file under the 500-line size
 * budget: registers the `warren login` / `warren prime` pair. `login`
 * verifies + persists base URL and token to the client config (D5);
 * `prime` emits the agent session context derived from the live program
 * definition, so the reference can never drift from the code.
 */

import type { Command } from "commander";
import { WarrenClient } from "../../client/index.ts";
import { addClientFlags, clientFlags, type RemoteOpts, resolveClientConfig } from "../client.ts";
import type { CliContext } from "../output.ts";
import { runLogin } from "./login.ts";
import { runPrime } from "./prime.ts";

/** Register the `login` and `prime` commands on the built program. */
export function registerBootstrapCommands(program: Command, context: CliContext): void {
	addClientFlags(
		program
			.command("login")
			.description(
				"verify a base URL + token against the server and persist them to the client config",
			),
	).action(async (opts: RemoteOpts) => {
		const result = await runLogin(
			context,
			{
				resolveConfig: (a) => resolveClientConfig(context.env, clientFlags(a)),
				makeClient: (config) => new WarrenClient({ config }),
				readTokenFromStdin,
			},
			{ url: opts.url, token: opts.token },
		);
		process.exit(result.exitCode);
	});

	program
		.command("prime")
		.description(
			"emit agent session context: command reference, env contract, exit codes, workflows",
		)
		.action(async () => {
			const result = await runPrime(context, { program });
			process.exit(result.exitCode);
		});
}

/**
 * Read a token piped on stdin (keeps the credential out of shell history).
 * A TTY stdin means the operator typed nothing — return empty and let the
 * login command report the missing token rather than blocking forever.
 */
async function readTokenFromStdin(): Promise<string> {
	if (process.stdin.isTTY === true) return "";
	let buf = "";
	for await (const chunk of process.stdin) {
		buf += String(chunk);
	}
	return buf;
}

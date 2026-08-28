/**
 * Operator-facing wording for a rejected credential (warren-2d4c).
 *
 * Two surfaces report the same failure: the `auth_valid` check in
 * `warren doctor` (`./commands/doctor-remote.ts`) and the catch-tail every
 * other command shares (`commandFailure` in `./output.ts`). The text lives
 * here once so the two cannot drift apart, and so the slots it names stay
 * the slots the resolution actually read: the config-file arm prints the
 * path `clientConfigPath` resolves, which honours `WARREN_CLIENT_CONFIG`,
 * instead of asserting `~/.warren/client.json`.
 */

import { clientConfigPath } from "../client/config-file.ts";
import type { ClientConfigSource } from "./client.ts";
import type { EnvLike } from "./output.ts";

/**
 * Name the slot the rejected credential came from, not every candidate. The
 * env arm carries the `.env` warning because that is the one an operator
 * cannot see: Bun loads the file before the process starts, so a stale token
 * in the repo they happen to be standing in outranks what `warren login` saved.
 *
 * An absent source means NO TOKEN AT ALL, which is a normal production
 * state rather than an unresolved caller (warren-4f1b). `resolveClientConfig`
 * picks the token from flag, env or config file with no default arm, so it
 * omits the source exactly when all three are empty, and both callers
 * resolve one for real. Sending that operator to check three empty slots
 * described a search they had already lost; the answer is `warren login`.
 */
export function authFailureHint(source: ClientConfigSource | undefined, env: EnvLike): string {
	const configFile = clientConfigPath(env);
	switch (source) {
		case "flag":
			return "the rejected token came from --token; check it against the server's credential";
		case "env":
			return `the rejected token came from WARREN_API_TOKEN in the environment; check it against the server's credential. An exported WARREN_API_TOKEN outranks the token \`warren login\` saved in ${configFile} — unset it to fall back to the config file. (The CLI never auto-loads a cwd \`.env\`, so the variable was exported in this shell.)`;
		case "config-file":
			return `the rejected token came from the client config file (${configFile}); re-run \`warren login\` to replace it`;
		default:
			return `no token is configured in any slot: --token, WARREN_API_TOKEN, and the client config file (${configFile}) are all empty. Run \`warren login\` to save one, or pass --token`;
	}
}

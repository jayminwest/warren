/**
 * Resolve a burrow transport from environment variables.
 *
 * V1's canonical deploy is single-container (docs/design/runtime-and-supervisor.md): warren and
 * `burrow serve` are sibling processes inside one container, the
 * supervisor binds burrow to a unix socket, warren reaches it through
 * that path. The TCP branch exists for tests, dev loops where burrow
 * runs on the host while warren runs in a container, and any future
 * cross-container deployment — burrow's HttpClient already supports
 * both via `Transport`, so we just plumb env vars through.
 *
 * Env contract (warren-namespaced so a sibling process running
 * `burrow` directly can keep its own `BURROW_*` env vars without
 * collision):
 *   WARREN_BURROW_SOCKET   unix socket path (default: /var/run/burrow.sock)
 *   WARREN_BURROW_HOST     TCP hostname; presence flips transport to TCP
 *   WARREN_BURROW_PORT     TCP port (required when WARREN_BURROW_HOST set)
 *   WARREN_BURROW_TOKEN    bearer token; only needed if burrow serves with
 *                          `--auth` rather than `--no-auth` (loopback default).
 *
 * Validation rule: TCP requires both host and port; specifying just host
 * is a misconfiguration. Mixing socket + TCP env vars is allowed —
 * presence of WARREN_BURROW_HOST wins so a deployer can flip transports
 * without unsetting the socket default.
 */

import type { Transport } from "@os-eco/burrow-cli";
import { ValidationError } from "../core/errors.ts";

export const DEFAULT_BURROW_SOCKET = "/var/run/burrow.sock";

export interface BurrowClientConfig {
	readonly transport: Transport;
	readonly token?: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function loadBurrowClientConfigFromEnv(env: EnvLike = process.env): BurrowClientConfig {
	const host = env.WARREN_BURROW_HOST;
	const portRaw = env.WARREN_BURROW_PORT;
	const token = env.WARREN_BURROW_TOKEN;

	let transport: Transport;
	if (host !== undefined && host !== "") {
		if (portRaw === undefined || portRaw === "") {
			throw new ValidationError("WARREN_BURROW_HOST is set but WARREN_BURROW_PORT is missing", {
				recoveryHint:
					"set WARREN_BURROW_PORT to burrow's TCP port, or unset HOST to use a unix socket",
			});
		}
		const port = Number.parseInt(portRaw, 10);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			throw new ValidationError(
				`WARREN_BURROW_PORT must be an integer 1..65535 (got ${JSON.stringify(portRaw)})`,
			);
		}
		transport = { kind: "tcp", hostname: host, port };
	} else {
		const path = env.WARREN_BURROW_SOCKET ?? DEFAULT_BURROW_SOCKET;
		if (path === "") {
			throw new ValidationError("WARREN_BURROW_SOCKET is set to an empty string", {
				recoveryHint: `unset WARREN_BURROW_SOCKET to fall back to ${DEFAULT_BURROW_SOCKET}`,
			});
		}
		transport = { kind: "unix", path };
	}

	return token !== undefined && token !== "" ? { transport, token } : { transport };
}

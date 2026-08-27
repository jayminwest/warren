/**
 * warren-ef6e fresh-install operator-token bootstrap, extracted from the
 * boot composition root (warren-48f8) so `main/index.ts` stays inside the
 * file-size budget. Behavior is unchanged: with no WARREN_API_TOKEN (and
 * no --no-auth), mint-or-reuse the persisted operator token.
 *
 * `process.env` is patched because dispatch-time run-token seams fall
 * through to `process.env` for the mint secret.
 */

import type { OperatorTokenResolution } from "../auth.ts";
import { resolveOperatorToken } from "../auth.ts";
import { DEFAULT_DATA_DIR, type EnvLike } from "../config.ts";

/** Info-shaped seam so tests can stay silent. */
export interface TokenBootstrapLogger {
	info(obj: object, msg: string): void;
}

export interface TokenBootstrapInput {
	readonly env: EnvLike;
	readonly noAuth?: boolean;
	readonly logger: TokenBootstrapLogger;
}

export interface TokenBootstrap {
	readonly tokenBoot: OperatorTokenResolution | null;
	/**
	 * The env to boot the rest of the server with — `env` untouched when the
	 * token came from the environment, otherwise carrying the resolved token
	 * as `WARREN_API_TOKEN`.
	 */
	readonly bootEnv: EnvLike;
}

export function bootstrapOperatorToken(input: TokenBootstrapInput): TokenBootstrap {
	const { env, logger } = input;
	const tokenBoot =
		input.noAuth === true
			? null
			: resolveOperatorToken(env, env.WARREN_DATA_DIR ?? DEFAULT_DATA_DIR);
	const bootEnv =
		tokenBoot === null || tokenBoot.source === "env"
			? env
			: { ...env, WARREN_API_TOKEN: tokenBoot.token };
	if (tokenBoot !== null && tokenBoot.source !== "env") {
		process.env.WARREN_API_TOKEN = tokenBoot.token;
		if (tokenBoot.source === "minted") {
			// The field name is deliberately NOT `token`: LOG_REDACT_OPTIONS censors
			// that name (warren-b2dd); this prints the credential exactly once (warren-ef6e).
			logger.info(
				{ mintedOperatorToken: tokenBoot.token, path: tokenBoot.path },
				"WARREN_API_TOKEN unset — minted an operator token (printed exactly once; persisted under the data dir)",
			);
		} else {
			logger.info(
				{ path: tokenBoot.path },
				"WARREN_API_TOKEN unset — reusing the persisted operator token",
			);
		}
	}
	return { tokenBoot, bootEnv };
}

/**
 * Warren API callback env for the sandbox (warren-f248, re-scoped warren-57fd).
 *
 * Injects a callback credential + a loopback base URL into a run's burrow
 * env so the agent/finalize harness can call back into warren's own HTTP API
 * (the in-pod steering poll and the two finalize legs). Without a credential
 * such calls return 401 (`src/server/auth.ts` requires a bearer token) because
 * the burrow otherwise carries only `ANTHROPIC_API_KEY` + `WARREN_QUALITY_GATE`.
 *
 * The credential is NOT the operator token. warren-57fd replaced the forwarded
 * operator bearer — which granted the sandbox full control-plane admin — with a
 * per-run scoped token (`src/runs/spawn/run-token.ts`) valid only for THIS
 * run's own callback surface and only while the run is live. On a public
 * instance the sandbox inputs are attacker-influenced (issue/PR text, repo
 * contents, contributed test/build scripts), so a captured callback token must
 * buy nothing beyond the run's own inbox + finalize.
 */

import { createHmacRunTokenMinter } from "./run-token.ts";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Mutate `env` to carry a run-scoped `WARREN_API_TOKEN` + `WARREN_API_URL`
 * derived from the server-process `serverEnv` and bound to `runId`.
 *
 * The token is minted from the instance operator token (`WARREN_API_TOKEN` in
 * `serverEnv`) as the signing secret; the server's auth layer re-derives and
 * verifies it against the same secret. Skips silently when the server runs
 * `--no-auth` (no operator token to sign with) — there is nothing to inject and
 * the sandbox has no callback credential, exactly as before. When warren is
 * bound to a unix socket only (no dialable TCP loopback) the token is still
 * injected but the URL is omitted — there's no TCP endpoint to hand the sandbox.
 */
export function injectWarrenCallbackEnv(
	env: Record<string, string>,
	serverEnv: EnvLike,
	runId: string,
): void {
	const secret = serverEnv.WARREN_API_TOKEN;
	if (secret === undefined || secret === "") return;
	env.WARREN_API_TOKEN = createHmacRunTokenMinter(secret).mint(runId);
	const url = loopbackApiUrl(serverEnv);
	if (url !== null) env.WARREN_API_URL = url;
}

/**
 * Build the loopback URL a sandboxed agent dials to reach warren's HTTP
 * API. Always `localhost` (the server's bind host may be `0.0.0.0`, which
 * isn't dialable) on `WARREN_BIND_PORT` (default 8080). Returns null when
 * warren is bound to a unix socket only.
 */
export function loopbackApiUrl(serverEnv: EnvLike): string | null {
	const socket = serverEnv.WARREN_BIND_SOCKET;
	if (socket !== undefined && socket !== "") return null;
	const portRaw = serverEnv.WARREN_BIND_PORT;
	const port = portRaw !== undefined && portRaw !== "" ? portRaw : "8080";
	return `http://localhost:${port}`;
}

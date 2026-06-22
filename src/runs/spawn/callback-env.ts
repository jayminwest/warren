/**
 * Warren API callback env for the sandbox (warren-f248).
 *
 * Injects the warren API token + a loopback base URL into a run's burrow
 * env so an agent can call back into warren's own HTTP API. The concrete
 * driver is the audit-warden delivery path: auditors POST each finding to
 * the standing "Audit Warden" conversation over
 * `POST /conversations/:id/messages` (warren-7f62). Without a credential
 * every such call returned 401 (`src/server/auth.ts` requires a bearer
 * token) because the auditor burrow only carried `ANTHROPIC_API_KEY` +
 * `WARREN_QUALITY_GATE`.
 *
 * V1 is single-user / single-token (SPEC §3.2 / §11.D), and the sandbox
 * already holds the operator's git push credential
 * (`installGitCredential`), so forwarding the same bearer token is
 * consistent with the existing trust boundary — the agent code is
 * operator-trusted by construction.
 */

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Mutate `env` to carry `WARREN_API_TOKEN` + `WARREN_API_URL` derived from
 * the server-process `serverEnv`.
 *
 * Skips silently when the server runs `--no-auth` (no token in env): there
 * is nothing useful to inject and the run env stays byte-identical to the
 * pre-change behavior. When warren is bound to a unix socket only (no
 * dialable TCP loopback) the token is still injected but the URL is
 * omitted — there's no TCP endpoint to hand the sandbox.
 */
export function injectWarrenCallbackEnv(env: Record<string, string>, serverEnv: EnvLike): void {
	const token = serverEnv.WARREN_API_TOKEN;
	if (token === undefined || token === "") return;
	env.WARREN_API_TOKEN = token;
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

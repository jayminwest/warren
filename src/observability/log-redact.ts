/**
 * Central pino redaction config for warren's loggers (warren-b2dd /
 * pl-f700 step 6).
 *
 * Lives under `src/observability/` because logging policy is an
 * observability concern, not an HTTP one. It used to sit in
 * `src/server/main/`, which forced `./error-tracking.ts` to import the
 * server from the observability layer (warren-89a6). Its consumers are the
 * server boot logger, the supervisor, the event projection and the Sentry
 * scrubber.
 *
 * Defense-in-depth: structured log objects should never carry a raw
 * GitHub token, bearer credential, or other secret-shaped value even
 * when a caller accidentally logs a whole config/headers object. pino's
 * `redact` option walks each log object and censors any value at the
 * listed paths before serialization, so the secret never reaches the
 * transport.
 *
 * The path list targets the field *names* warren actually threads
 * through its structured logs — both the literal env-var names
 * (`GITHUB_TOKEN`, `BURROW_API_TOKEN`, …) and the camelCase fields on
 * the typed config objects (`githubToken`, `token`, …), at the top
 * level and one level of nesting (`*.token`). pino redact paths are not
 * deep-recursive by default, so we enumerate the wildcard explicitly.
 *
 * This is a backstop, not a license to log secrets — call sites should
 * still redact at the source (e.g. `redactDbUrl`). The censor string is
 * the pino default `[Redacted]`.
 */

/**
 * Secret-shaped field names warren may attach to a structured log
 * object. Listed bare and as a one-level wildcard so both
 * `{ token }` and `{ config: { token } }` are caught.
 */
export const SECRET_FIELDS = [
	"token",
	"githubToken",
	"warrenBurrowToken",
	"authorization",
	"bearer",
	"password",
	"secret",
	"apiKey",
	"GITHUB_TOKEN",
	// warren-1b6f: the forge-neutral spelling the github arm now reads first.
	"WARREN_GIT_TOKEN",
	"BURROW_API_TOKEN",
	"WARREN_BURROW_TOKEN",
	// warren-9bbc: snake_case JSON keys an agent transcript or an OAuth /
	// vendor SDK dump actually carries — the camelCase-only list above
	// missed `{ access_token, refresh_token, client_secret, … }` payloads
	// in both the event-stream scrubber and the Sentry scrubber, which
	// share this policy.
	"api_key",
	"access_token",
	"accessToken",
	"refresh_token",
	"refreshToken",
	"client_secret",
	"clientSecret",
	"private_key",
	"privateKey",
	// warren-6c4c: the per-spawn git-credential env (gitCredentialGitEnv,
	// forge-contract.md §4) embeds the minted secret inline in
	// GIT_CONFIG_KEY_0's `url.https://x-access-token:<secret>@…` value — list
	// the names so a logged SpawnOptions.env can never leak one.
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	// warren-4e1c: the per-spawn minted push credential rides
	// `FinalizeIntent.gitCredential` / `WorkspaceSalvageInput.gitCredential`:
	// list the field name so a logged intent/salvage object can never leak
	// one. `gitToken` stays listed: the in-pod finalize wire still carries the
	// bare secret under that name (warren-1b6f).
	"gitCredential",
	"gitToken",
	// warren-f8df: the GitHub App forge (src/forge/github-app/) — the cached
	// `ghs_` installation token, the env var holding the App's PEM, and any
	// field carrying a signed App JWT. A logged cache/config object can
	// never leak one.
	"installationToken",
	"WARREN_GITHUB_APP_PRIVATE_KEY",
	"jwt",
	// warren-a647: the manifest-registration conversion response
	// (src/forge/github-app/registration.ts) carries the new App's PEM under
	// the bare field name `pem` — a logged conversion/registration object
	// can never leak the private key. The response's `client_secret` /
	// `clientSecret` names are already listed above (warren-9bbc).
	"pem",
] as const;

/**
 * pino `redact.paths` value: every secret field at the top level plus a
 * single nested wildcard (`*.<field>`) and an explicit `headers.*`
 * authorization path for request-shaped logs.
 */
export const LOG_REDACT_PATHS: string[] = [
	...SECRET_FIELDS,
	...SECRET_FIELDS.map((f) => `*.${f}`),
	"headers.authorization",
	'headers["authorization"]',
	'headers["x-burrow-token"]',
	// Dashed header names can't ride the SECRET_FIELDS list — pino redact
	// paths parse `.` segments, so `x-api-key` needs bracket notation.
	'headers["x-api-key"]',
];

/**
 * The `redact` option object passed to `pino({ ... })`. Centralized so
 * every warren logger (server boot + supervisor) shares one policy.
 */
export const LOG_REDACT_OPTIONS = {
	paths: LOG_REDACT_PATHS,
	censor: "[Redacted]",
} as const;

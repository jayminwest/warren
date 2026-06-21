/**
 * Central pino redaction config for warren's loggers (warren-b2dd /
 * pl-f700 step 6).
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
const SECRET_FIELDS = [
	"token",
	"githubToken",
	"warrenBurrowToken",
	"authorization",
	"bearer",
	"password",
	"secret",
	"apiKey",
	"GITHUB_TOKEN",
	"BURROW_API_TOKEN",
	"WARREN_BURROW_TOKEN",
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
];

/**
 * The `redact` option object passed to `pino({ ... })`. Centralized so
 * every warren logger (server boot + supervisor) shares one policy.
 */
export const LOG_REDACT_OPTIONS = {
	paths: LOG_REDACT_PATHS,
	censor: "[Redacted]",
} as const;

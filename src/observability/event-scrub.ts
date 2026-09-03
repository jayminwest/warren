/**
 * Event-payload credential scrubber (warren-1cb7 / pl-b82d step 16;
 * relocated from `src/server/handlers/runs/event-projection.ts` in
 * warren-4001 so the reap path can redact provider-error text BEFORE
 * storing it, not only when projecting it to spectators).
 *
 * The warren-cbd8 redaction rules live here, once:
 *
 *   - {@link SECRET_PATTERN} — known credential shapes (PEM blocks,
 *     bearer headers, API-key prefixes, DSN userinfo, JWTs, …).
 *   - {@link SECRET_FIELD_SET} — object keys censored on the key alone
 *     (secret-named fields plus internal runtime handles like
 *     `sandboxId` that the run projection withholds).
 *   - {@link buildEnvSecretPattern} — this instance's own env secrets,
 *     matched by literal value.
 *
 * A scrubbed value is replaced with {@link REDACTED_MARKER} — a visible
 * marker, never a deletion, so a viewer can tell scrubbing happened
 * rather than wondering whether the agent said nothing.
 *
 * **Residual risk, explicitly accepted.** Text that echoes a NOVEL
 * secret — one matching none of the shapes below and absent from this
 * instance's env — lands verbatim. No pattern matcher closes that gap.
 * Read this module as a floor, not as a promise that arbitrary text is
 * safe to expose.
 */

import { SECRET_FIELDS } from "./log-redact.ts";

/**
 * What a scrubbed value is replaced with. Lowercase and distinct from
 * pino's `[Redacted]` censor so a marker on the wire is traceable to this
 * module rather than to a log record that leaked into a payload.
 */
export const REDACTED_MARKER = "[redacted]";

/**
 * Field names whose value is censored on sight, reusing the central pino
 * policy. `x-api-key` rides along here rather than in SECRET_FIELDS because
 * pino redact paths can't express the dash — the event scrubber matches on
 * the lowercased key alone, so it can (warren-9bbc).
 *
 * `sandboxId` rides along for a different reason: it is not a credential,
 * it is an internal runtime handle the run projection already withholds
 * (`REDACTED_RUN_FIELDS`, warren-946f), and system events like
 * `reap.workspace_destroyed` re-leaked it through the transcript
 * (warren-5f59). `sandboxRunId` is the same class of handle —
 * `watchdog.terminal_reconciled` re-leaked it (warren-d8f4), and under
 * `WARREN_RUNTIME=k8s` the value is a real Kubernetes pod UID, not
 * something derivable from the run id. Censoring on the key keeps the
 * handle off the public stream wherever a payload carries it, without
 * dropping the event — the rest of the payload (`archived`, timestamps)
 * is spectator-visible fact.
 *
 * `bundlePath` / `salvagePath` are the third instance of that same pattern
 * (warren-7c1e). `salvagePath` is a `REDACTED_RUN_FIELDS` member — an
 * absolute host filesystem path, the same class as `localPath` — yet three
 * salvage events (`reap.workspace_salvaged`,
 * `reap.workspace_salvage_recorded`, and the intake's own emit) published
 * the identical value to spectators under the name `bundlePath`. A field
 * the run row withholds means nothing while the transcript hands it back.
 * `rescueRef` deliberately stays in the clear: it is a branch name on the
 * project's origin carrying only the already-public run id, and
 * `PUBLIC_RUN_FIELDS` admits it as `salvageRef` for exactly that reason.
 */
const SECRET_FIELD_SET = new Set<string>([
	...SECRET_FIELDS.map((f) => f.toLowerCase()),
	"x-api-key",
	"sandboxid",
	"sandboxrunid",
	"bundlepath",
	"salvagepath",
]);

/**
 * Known credential shapes, compiled as ONE alternation so a payload string
 * is walked once — the scrubber runs per event on a live stream on a
 * single-replica control plane, so per-string cost is the budget.
 *
 * Group 1 is the ONLY capturing group in the whole pattern: the
 * `Authorization: Bearer` prefix, kept so the redaction still reads as a
 * header. Every other alternative must use `(?:…)` or {@link redactMatch}
 * loses that invariant.
 */
const SECRET_PATTERN = new RegExp(
	[
		// PEM blocks — the whole armored body, non-greedy to the matching END.
		String.raw`-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----`,
		// `Authorization: Bearer <token>` in a curl line, a header dump, a stack trace.
		String.raw`((?:proxy-)?authorization\s*[:=]\s*"?(?:bearer|basic|token)\s+)[\w.\-+/=~]+`,
		// Anthropic. Must precede the generic `sk-` alternative to win the match.
		String.raw`sk-ant-[\w-]{16,}`,
		// OpenAI-style `sk-` keys, incl. the `sk-proj-` / `sk-svcacct-` prefixes.
		"sk-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}",
		// GitHub personal / OAuth / user-to-server / server-to-server / refresh tokens.
		"gh[pousr]_[A-Za-z0-9]{20,}",
		// GitHub fine-grained PATs.
		"github_pat_[A-Za-z0-9_]{20,}",
		// AWS access key ids — long-lived (AKIA) and STS session (ASIA).
		"(?:AKIA|ASIA)[0-9A-Z]{16}",
		// Slack bot / user / app-level / refresh tokens.
		"xox[baprs]-[A-Za-z0-9-]{10,}",
		// Slack incoming-webhook URLs — the path tail IS the credential.
		String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9]+/[A-Za-z0-9]+/[A-Za-z0-9]+`,
		// Linear personal API keys (warren-9bbc — a `lin_api_` key quoted into
		// a transcript used to sail through every shape above).
		"lin_api_[0-9a-fA-F]{40}",
		// Stripe secret / restricted keys (live AND test — a test key in a
		// transcript is still a credential shape) and webhook-signing secrets.
		"(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}",
		"whsec_[A-Za-z0-9]{16,}",
		// GitLab personal access tokens.
		"glpat-[A-Za-z0-9_-]{20,}",
		// npm access tokens.
		"npm_[A-Za-z0-9]{36}",
		// SendGrid API keys (`SG.` + two base64url segments).
		String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
		// Google API keys.
		"AIza[0-9A-Za-z_-]{35}",
		// URL userinfo credentials: `scheme://user:pass@host`. This is where a
		// Postgres DSN (WARREN_DB_URL) hides its password. Anchored on
		// the `:pass@` shape so an ordinary URL without userinfo never matches.
		// Redacted whole (scheme + userinfo + `@`), leaving the host in the clear.
		String.raw`\w+://[^\s:@/]+:[^\s@/]+@`,
		// JWTs — three base64url segments joined by dots. Anchored on the `eyJ`
		// header prefix (base64url of `{"`) so a dotted identifier like
		// `foo.bar.baz` is never mistaken for a token.
		String.raw`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`,
	].join("|"),
	"gi",
);

/**
 * Env var names whose VALUE is a credential on this instance. Matched on
 * the trailing word so a `*_TOKEN` / `*_API_KEY` introduced tomorrow is
 * covered the day it lands; `…_NAME` / `…_PATH` knobs that merely *point*
 * at a secret (`WARREN_K8S_ANTHROPIC_SECRET_NAME`) deliberately fall
 * outside.
 */
const SECRET_ENV_NAME =
	/(?:^|_)(?:TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIALS?|DSN|URL|URI|CONN)$/i;

/**
 * Env values shorter than this are not redacted. A 4-character token is
 * indistinguishable from ordinary transcript text, and blanket-replacing
 * it would mangle the stream far more visibly than it would protect it.
 */
const MIN_ENV_SECRET_LENGTH = 12;

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile the literal-value matcher for this instance's own secrets, or
 * `null` when the env holds none. Pure over an injected env so it is
 * testable without touching `process.env`; the wired path memoizes it
 * ({@link instanceEnvSecretPattern}) because instance env is boot-fixed
 * and recompiling per event would be the one expensive thing here.
 */
export function buildEnvSecretPattern(
	env: Readonly<Record<string, string | undefined>>,
): RegExp | null {
	const values = new Set<string>();
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || value.length < MIN_ENV_SECRET_LENGTH) continue;
		if (!SECRET_ENV_NAME.test(name)) continue;
		values.add(value);
	}
	if (values.size === 0) return null;
	// Longest first: when one env value is a prefix of another, the longer
	// one must win the alternation or its tail survives in the clear.
	const alternatives = [...values].sort((a, b) => b.length - a.length).map((v) => escapeRegExp(v));
	return new RegExp(alternatives.join("|"), "g");
}

let cachedEnvPattern: RegExp | null | undefined;

export function instanceEnvSecretPattern(): RegExp | null {
	if (cachedEnvPattern === undefined) cachedEnvPattern = buildEnvSecretPattern(process.env);
	return cachedEnvPattern;
}

/** `undefined` for group 1 means some other alternative matched — redact whole. */
function redactMatch(_match: string, authPrefix: string | undefined): string {
	return authPrefix === undefined ? REDACTED_MARKER : `${authPrefix}${REDACTED_MARKER}`;
}

function scrubString(text: string, envPattern: RegExp | null): string {
	const withoutEnvSecrets = envPattern === null ? text : text.replace(envPattern, REDACTED_MARKER);
	return withoutEnvSecrets.replace(SECRET_PATTERN, redactMatch);
}

/**
 * Deep-scrub a JSON payload. Strings are pattern-matched; object values
 * under a secret-shaped key are censored on the key alone, so
 * `{ headers: { authorization: "<anything>" } }` is covered even when the
 * value carries no recognizable prefix.
 *
 * `envPattern` is threaded rather than read from module state so the walk
 * stays pure and the corpus test can pin instance-secret behavior.
 */
export function scrubSecrets(value: unknown, envPattern: RegExp | null): unknown {
	if (typeof value === "string") return scrubString(value, envPattern);
	if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, envPattern));
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = SECRET_FIELD_SET.has(key.toLowerCase())
				? REDACTED_MARKER
				: scrubSecrets(item, envPattern);
		}
		return out;
	}
	return value;
}

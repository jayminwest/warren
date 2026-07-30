/**
 * Public projection for the run event stream (warren-1cb7 / pl-b82d step 16).
 *
 * `events.payload_json` is the raw agent transcript: `tool_use` inputs
 * carrying shell command lines, `tool_result` outputs carrying file
 * contents and stack traces. It is served verbatim as NDJSON from
 * `GET /runs/:id/events` and its plan-run twin, both `readPublic` routes.
 * That makes it the widest disclosure surface on a public instance and the
 * one place where the field-allowlist discipline of
 * `src/server/projection.ts` does not reach — the payload is a free-form
 * blob whose interesting content is exactly the part we cannot enumerate.
 *
 * So the projection here is two narrower moves:
 *
 * 1. {@link INTERNAL_EVENT_KINDS} — event kinds dropped whole, because
 *    their payload is control-plane plumbing and nothing else.
 * 2. {@link scrubSecrets} — a deep walk that replaces known credential
 *    shapes, secret-named fields, and this instance's own env secrets with
 *    {@link REDACTED_MARKER}. A visible marker, never a deletion, so a
 *    viewer can tell scrubbing happened rather than wondering whether the
 *    agent said nothing.
 *
 * Both run server-side, on the NDJSON projection. The stream IS the API
 * (PHILOSOPHY rule 5); anything relying on the UI to redact is not
 * redacted, since a spectator can `curl` the same route.
 *
 * **Why the kind list is a denylist** when `src/server/projection.ts`
 * mandates allowlists: `NormalizedEvent.kind` is an OPEN string
 * (`src/runtime/contract.ts` §6.6) — burrow and the K8s log parser forward
 * whatever the harness emits, and new kinds arrive with runtime releases
 * warren does not gate. An allowlist there would silently swallow the
 * transcript on the next burrow bump, i.e. break the surface it is meant
 * to protect. The allowlist discipline still holds where the vocabulary is
 * closed — the NDJSON envelope names its fields explicitly in
 * `eventToNdjson` — and the scrubber runs over every payload regardless of
 * kind, so an unclassified kind is scrubbed, not trusted.
 *
 * **Residual risk, explicitly accepted.** An agent that echoes a NOVEL
 * secret — one matching none of the shapes below and absent from this
 * instance's env — into a stack trace lands verbatim. No pattern matcher
 * closes that gap. The structural mitigation is the public-instance org
 * allowlist (warren-ce9b): every repo the instance runs against is public,
 * so the workspace content a transcript quotes is already public. Read
 * this module as the floor under an already-public surface, not as a
 * promise that arbitrary agent output is safe to expose.
 */

import { SECRET_FIELDS } from "../../../observability/log-redact.ts";
import { isPublicOnly } from "../../projection.ts";
import type { Actor } from "../../types.ts";

/**
 * What a scrubbed value is replaced with. Lowercase and distinct from
 * pino's `[Redacted]` censor so a marker on the wire is traceable to this
 * module rather than to a log record that leaked into a payload.
 */
export const REDACTED_MARKER = "[redacted]";

/**
 * Event kinds a `readPublic`-only caller never sees.
 *
 * The bridge lifecycle events are warren's own reconnect bookkeeping and
 * their payloads are `{ burrowRunId, burrowId, attempts, … }` — the
 * internal runtime handles `REDACTED_RUN_FIELDS` (warren-946f) already
 * withholds from the run row. Serving them here would hand back through
 * the transcript exactly what the run projection drops, and a spectator
 * has no use for them either way.
 *
 * Keep this list to kinds that are *purely* internal. A kind that carries
 * any spectator-visible fact (`spawn_failed`, `reap_failed`, `budget.exceeded`)
 * stays on the stream and is scrubbed like everything else.
 */
export const INTERNAL_EVENT_KINDS: ReadonlySet<string> = new Set([
	"bridge_stalled",
	"bridge_recovered",
	"bridge_lost",
	"bridge_fatal",
]);

/** Field names whose value is censored on sight, reusing the central pino policy. */
const SECRET_FIELD_SET = new Set<string>(SECRET_FIELDS.map((f) => f.toLowerCase()));

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
		// URL userinfo credentials: `scheme://user:pass@host`. This is where a
		// Postgres / Supabase DSN (WARREN_DB_URL) hides its password. Anchored on
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

function instanceEnvSecretPattern(): RegExp | null {
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

/** The shape the projection reads. Structurally satisfied by an `EventRow`. */
interface ProjectableEvent {
	readonly kind: string;
	readonly payloadJson: unknown;
}

/**
 * Narrow one event row for `actor`. The operator gets the row by
 * reference, untouched — the public stream is provably the operator
 * stream minus content, because there is only one construction site.
 *
 * `null` means the event is dropped entirely; the NDJSON encoder turns
 * that into no line on the wire rather than an empty one.
 */
export function projectEvent<T extends ProjectableEvent>(
	row: T,
	actor: Actor | undefined,
): T | null {
	if (!isPublicOnly(actor)) return row;
	if (INTERNAL_EVENT_KINDS.has(row.kind)) return null;
	return { ...row, payloadJson: scrubSecrets(row.payloadJson, instanceEnvSecretPattern()) };
}

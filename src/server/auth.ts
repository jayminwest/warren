/**
 * Bearer-token auth for `warren serve` (SPEC §8.1).
 *
 * V1 posture is single-user (SPEC §3.2 / §11.D): one bearer token from
 * `WARREN_API_TOKEN`, missing/invalid → 401. The `AuthProvider` seam
 * exists so a future multi-user landing (per-token scopes, OIDC, ...)
 * can plug in additively without rewriting handlers.
 *
 * A successful `authorize` returns an `Actor` — an identity discriminant
 * plus a capability set (warren-1ff0) — which the server threads onto
 * `RouteContext.actor`. `NO_AUTH` and `bearerAuth` return the
 * full-capability `OPERATOR_ACTOR`; `publicReadAuth` (warren-851b) is the
 * narrower provider the seam exists for — a credential-less caller gets
 * `ANONYMOUS_ACTOR` (`readPublic` and nothing else), a token holder still
 * gets the operator, so one deployment serves spectators and its operator.
 *
 * What that actor may then reach is `policyAllows` (warren-b875) applied to
 * the route's declared `RoutePolicy` — the capability check the server's
 * request gate runs once per matched route.
 *
 * Which backend a process runs is resolved ONCE at boot from `WARREN_AUTH`
 * (`resolveAuthKind`), exactly like `WARREN_RUNTIME` in
 * `src/runtime/registry.ts`: unset/blank → `token` (the default, so the
 * fresh-install path is untouched), `public` → the public-read provider,
 * anything else → `UnknownAuthProviderError`. The selector NEVER falls
 * back to `public` — a missing, empty, or unparseable value resolves to
 * `token` or refuses the boot, because a private repo registered on an
 * instance that silently degraded to public is the worst outcome here.
 *
 * `--no-auth` (loopback-only) is the dev-loop escape hatch. The CLI
 * plumbs it through `resolveAuth({ noAuth: true })`; the server itself
 * never inspects the flag (auth is opaque to dispatch).
 *
 * Token comparison uses `timingSafeEqual` after a length pre-check so a
 * mismatched-length token still resolves in roughly the same time as a
 * matched-length one. This mirrors burrow's auth.ts; same posture, same
 * threat-model assumption (single-user, single-token).
 */

import { timingSafeEqual } from "node:crypto";
import { ValidationError, WarrenError } from "../core/errors.ts";
import type {
	Actor,
	ActorCapabilities,
	AuthDenied,
	AuthOk,
	AuthOutcome,
	AuthProvider,
	CapabilityName,
	RoutePolicy,
} from "./types.ts";

/** Every capability. The V1 posture: an admitted caller may do anything. */
const FULL_CAPABILITIES: ActorCapabilities = Object.freeze({
	readPublic: true,
	readOperator: true,
	dispatch: true,
	admin: true,
});

/**
 * The single-user V1 caller (warren-1ff0). Both providers below authorize
 * exactly this actor, so widening `AuthOk` grants nobody anything new — a
 * provider that grants a narrower set is the point of the seam, not this
 * constant.
 */
export const OPERATOR_ACTOR: Actor = Object.freeze({
	kind: "operator",
	capabilities: FULL_CAPABILITIES,
});

const ALLOW: AuthOk = Object.freeze({ ok: true, actor: OPERATOR_ACTOR });

/** Read the public projection, nothing else. Every mutation is absent. */
const READ_PUBLIC_ONLY: ActorCapabilities = Object.freeze({
	readPublic: true,
	readOperator: false,
	dispatch: false,
	admin: false,
});

/**
 * The credential-less spectator `WARREN_AUTH=public` admits (warren-851b).
 * Holding only `readPublic` means every mutation is refused by the policy
 * layer on the capability it lacks, not by a check inside a handler.
 */
export const ANONYMOUS_ACTOR: Actor = Object.freeze({
	kind: "anonymous",
	capabilities: READ_PUBLIC_ONLY,
});

const ALLOW_ANONYMOUS: AuthOk = Object.freeze({ ok: true, actor: ANONYMOUS_ACTOR });

class NoAuthProvider implements AuthProvider {
	authorize(): AuthOutcome {
		return ALLOW;
	}
}

class BearerTokenAuth implements AuthProvider {
	private readonly tokenBytes: Uint8Array;

	constructor(token: string) {
		if (token.length === 0) {
			throw new Error("bearerAuth: token must be a non-empty string");
		}
		this.tokenBytes = new TextEncoder().encode(token);
	}

	authorize(request: Request): AuthOutcome {
		const header = request.headers.get("authorization");
		if (header === null) {
			return deny(401, "unauthorized", "missing Authorization header", 'Bearer realm="warren"');
		}
		const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
		if (!match?.[1]) {
			return deny(
				401,
				"unauthorized",
				"expected 'Bearer <token>' Authorization header",
				'Bearer realm="warren", error="invalid_request"',
			);
		}
		if (!constantTimeEqualString(match[1], this.tokenBytes)) {
			return deny(
				401,
				"unauthorized",
				"invalid bearer token",
				'Bearer realm="warren", error="invalid_token"',
			);
		}
		return ALLOW;
	}
}

/**
 * `WARREN_AUTH=public`: an unauthenticated caller is a spectator, an
 * authenticated one is still the operator (warren-851b).
 *
 * A request that offers NO credentials is admitted as `ANONYMOUS_ACTOR`.
 * A request that DOES offer credentials is held to them and delegated to
 * the wrapped operator provider — a stale or malformed token 401s rather
 * than silently degrading to the public projection, so an operator client
 * with a bad token learns that instead of quietly reading redacted data.
 */
class PublicReadProvider implements AuthProvider {
	private readonly operator: AuthProvider;

	constructor(operator: AuthProvider) {
		this.operator = operator;
	}

	authorize(request: Request): AuthOutcome {
		if (request.headers.get("authorization") === null) return ALLOW_ANONYMOUS;
		return this.operator.authorize(request);
	}
}

/**
 * Does `actor` satisfy `policy`? The whole authorization decision, in one
 * expression (warren-b875): `anonymous` demands nothing, every other policy
 * names the capability flag the actor must carry. The gate in `server.ts`
 * calls this once per matched route; no handler re-checks.
 */
export function policyAllows(actor: Actor, policy: RoutePolicy): boolean {
	if (policy === "anonymous") return true;
	return actor.capabilities[policy];
}

/**
 * The capability names `actor` actually holds, in the order its capability
 * record declares them (warren-e195). Derived from the record instead of a
 * second literal list, so a capability added to `ActorCapabilities` reaches
 * `GET /whoami` automatically rather than silently dropping off the wire.
 */
export function grantedCapabilities(actor: Actor): CapabilityName[] {
	const names = Object.keys(actor.capabilities) as CapabilityName[];
	return names.filter((name) => actor.capabilities[name]);
}

/** Allow every request. Used by `--no-auth` / loopback-only deploys. */
export const NO_AUTH: AuthProvider = new NoAuthProvider();

/** Build an AuthProvider that requires a single bearer token. */
export function bearerAuth(token: string): AuthProvider {
	return new BearerTokenAuth(token);
}

/**
 * Build the public-read AuthProvider — anonymous callers get `readPublic`,
 * credentialed ones are resolved by `operator` (normally a `bearerAuth`).
 */
export function publicReadAuth(operator: AuthProvider): AuthProvider {
	return new PublicReadProvider(operator);
}

/** Auth backends the `WARREN_AUTH` selector understands. */
export type AuthKind = "token" | "public";

/** Selector default when `WARREN_AUTH` is unset — the fresh-install posture. */
export const DEFAULT_AUTH_KIND: AuthKind = "token";

/** Every recognized `WARREN_AUTH` value (used for validation + error hints). */
export const AUTH_KINDS: readonly AuthKind[] = ["token", "public"];

/** Minimal env surface the auth selector reads. */
export type AuthEnv = Readonly<Record<string, string | undefined>>;

/**
 * Thrown when `WARREN_AUTH` names a provider the registry doesn't know.
 * Mirrors `UnknownRuntimeError`: fail loud at boot rather than fall back,
 * so a typo can never widen (or narrow) who may reach the instance.
 */
export class UnknownAuthProviderError extends WarrenError {
	readonly code = "unknown_auth_provider";
}

/**
 * Parse + validate the `WARREN_AUTH` selector. Blank/unset resolves to
 * `token`; an unrecognized value throws. There is no path from a
 * degenerate value to `public` — that is the whole point (warren-851b).
 */
export function resolveAuthKind(env: AuthEnv = process.env): AuthKind {
	const raw = env.WARREN_AUTH?.trim();
	if (raw === undefined || raw === "") {
		return DEFAULT_AUTH_KIND;
	}
	if ((AUTH_KINDS as readonly string[]).includes(raw)) {
		return raw as AuthKind;
	}
	throw new UnknownAuthProviderError(`Unknown WARREN_AUTH "${raw}"`, {
		recoveryHint: `Set WARREN_AUTH to one of: ${AUTH_KINDS.join(", ")} (or leave it unset for "${DEFAULT_AUTH_KIND}").`,
	});
}

export interface ResolveAuthOptions {
	/** Skip auth entirely (CLI `--no-auth`). Wins over every other field. */
	noAuth?: boolean;
	/** Explicit token (test fixtures, mostly). Wins over env. */
	token?: string;
	/** Explicit backend (boot resolves it itself). Wins over `env.WARREN_AUTH`. */
	kind?: AuthKind;
	/** Environment to read from. Defaults to `process.env`. */
	env?: AuthEnv;
}

/**
 * Resolve an AuthProvider from CLI inputs — call ONCE at boot.
 *
 * Precedence: `noAuth` > `token` > `env.WARREN_API_TOKEN` for the token,
 * `kind` > `env.WARREN_AUTH` for the backend. Throws
 * `ValidationError` if no token is found and `noAuth` is not set (an
 * operator token is required in EVERY mode — `public` widens who may
 * read, it never removes the operator's way in), and
 * `UnknownAuthProviderError` on an unrecognized `WARREN_AUTH`. The CLI
 * surfaces either as a non-zero exit.
 */
export function resolveAuth(opts: ResolveAuthOptions = {}): AuthProvider {
	if (opts.noAuth) return NO_AUTH;
	const env = opts.env ?? process.env;
	const kind = opts.kind ?? resolveAuthKind(env);
	const token = opts.token ?? env.WARREN_API_TOKEN;
	if (token === undefined || token.length === 0) {
		throw new ValidationError("WARREN_API_TOKEN is not set", {
			recoveryHint: "export WARREN_API_TOKEN=<token> or pass --no-auth (loopback only)",
		});
	}
	const operator = bearerAuth(token);
	return kind === "public" ? publicReadAuth(operator) : operator;
}

function deny(status: number, code: string, message: string, challenge?: string): AuthDenied {
	return challenge !== undefined
		? { ok: false, status, code, message, challenge }
		: { ok: false, status, code, message };
}

function constantTimeEqualString(candidate: string, expected: Uint8Array): boolean {
	const candidateBytes = new TextEncoder().encode(candidate);
	if (candidateBytes.length !== expected.length) return false;
	return timingSafeEqual(candidateBytes, expected);
}

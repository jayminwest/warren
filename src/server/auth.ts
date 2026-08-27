/**
 * Bearer-token auth for `warren serve` (docs/http-api.md).
 *
 * V1 posture is single-user (SECURITY.md): one bearer token from
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

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError, WarrenError } from "../core/errors.ts";
import { isRunScopedToken, verifyRunScopedToken } from "../runs/spawn/run-token.ts";
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

/**
 * A run-scoped callback token holds `readOperator` + `dispatch` so it clears
 * the capability gate on its five callback routes (`GET .../inbox` +
 * `.../finalize-intent` are `readOperator`, `POST .../finalize-result`,
 * `POST .../salvage`, and `POST .../git-credential` are `dispatch`). This does
 * NOT let it read arbitrary
 * operator surfaces: the
 * request gate additionally pins a `run` actor to `RUN_CALLBACK_ROUTE_PATTERNS`
 * for its OWN run id and refuses once that run is terminal (warren-57fd). The
 * narrow route+id+liveness rule is the real boundary; these flags only let the
 * legitimate callbacks through the shared capability check.
 */
const RUN_SCOPED_CAPABILITIES: ActorCapabilities = Object.freeze({
	readPublic: false,
	readOperator: true,
	dispatch: true,
	admin: false,
});

/** Build the `run`-kind actor a valid run-scoped token authorizes. */
export function runScopedActor(runId: string): Actor {
	return Object.freeze({ kind: "run", capabilities: RUN_SCOPED_CAPABILITIES, runId });
}

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
 * Wraps an operator/public provider and admits run-scoped callback tokens
 * (warren-57fd). A bearer shaped like a run token (`isRunScopedToken`) is
 * verified against `secret` (the instance operator token, shared with the
 * dispatch-time minter): a valid signature yields a `run` actor bound to its
 * run id; a shaped-but-invalid token 401s rather than falling through to the
 * operator check (so a tampered run token never accidentally matches the
 * operator bearer). Any other bearer is delegated unchanged.
 */
class RunScopedAuthProvider implements AuthProvider {
	private readonly inner: AuthProvider;
	private readonly secret: string;

	constructor(inner: AuthProvider, secret: string) {
		this.inner = inner;
		this.secret = secret;
	}

	authorize(request: Request): AuthOutcome {
		const header = request.headers.get("authorization");
		const match = header !== null ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
		const presented = match?.[1];
		if (presented !== undefined && isRunScopedToken(presented)) {
			const runId = verifyRunScopedToken(presented, this.secret);
			if (runId !== null) return { ok: true, actor: runScopedActor(runId) };
			return deny(
				401,
				"unauthorized",
				"invalid run-scoped token",
				'Bearer realm="warren", error="invalid_token"',
			);
		}
		return this.inner.authorize(request);
	}
}

/**
 * Wrap `inner` so run-scoped callback tokens signed with `secret` are admitted
 * as `run` actors (warren-57fd). `secret` is the operator token the
 * dispatch-time minter also keys off, so mint and verify share it with no
 * extra config.
 */
export function runScopedAuth(inner: AuthProvider, secret: string): AuthProvider {
	return new RunScopedAuthProvider(inner, secret);
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

/**
 * Filename of the persisted operator token under `WARREN_DATA_DIR`
 * (warren-ef6e). One line, mode 0600. The name is deliberately generic —
 * it is the instance's own credential, not scoped to the auth selector.
 */
export const OPERATOR_TOKEN_FILE = "operator-token";

/** Where the operator token came from on this boot. */
export type OperatorTokenSource =
	/** `WARREN_API_TOKEN` was set explicitly — always wins (warren-ef6e). */
	| "env"
	/** The persisted token file existed from a previous boot; reused as-is. */
	| "file"
	/** Nothing existed; a fresh token was minted and persisted this boot. */
	| "minted";

export interface OperatorTokenResolution {
	readonly token: string;
	readonly source: OperatorTokenSource;
	/** Path of the persisted token file (absent when `source` is `"env"`). */
	readonly path?: string;
}

/**
 * Resolve the operator bearer token for this boot (warren-ef6e), minting +
 * persisting one on first boot so a fresh-install operator never hand-mints
 * a credential.
 *
 * Precedence: a non-empty `WARREN_API_TOKEN` ALWAYS wins, even over the
 * persisted file. Failing that, `<dataDir>/operator-token` is read (a reused
 * file is chmod-renormalized to 0600, best-effort). Failing that, 32 random
 * bytes are minted as base64url, persisted with mode 0600 under `dataDir`
 * (created 0700), and returned with `source: "minted"` so the boot wiring
 * can print it exactly once. An empty-string env is treated as unset,
 * matching `resolveToken` in `server/config.ts`.
 *
 * A persisted-file read or write failure throws a `ValidationError` naming
 * the path — silently booting on a DIFFERENT token than the one on disk
 * would strand every client holding the old one.
 */
export function resolveOperatorToken(env: AuthEnv, dataDir: string): OperatorTokenResolution {
	const explicit = env.WARREN_API_TOKEN;
	if (explicit !== undefined && explicit !== "") {
		return { token: explicit, source: "env" };
	}
	const path = join(dataDir, OPERATOR_TOKEN_FILE);
	let persisted: string | undefined;
	try {
		persisted = readFileSync(path, "utf8").trim();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new ValidationError(`failed to read the persisted operator token at ${path}`, {
				cause: err,
				recoveryHint: `remove or fix ${path}, or export WARREN_API_TOKEN to override it`,
			});
		}
	}
	if (persisted !== undefined && persisted !== "") {
		try {
			chmodSync(path, 0o600);
		} catch {
			// best-effort permission hygiene; never block the boot on it
		}
		return { token: persisted, source: "file", path };
	}
	const token = randomBytes(32).toString("base64url");
	try {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		writeFileSync(path, `${token}\n`, { mode: 0o600 });
	} catch (err) {
		throw new ValidationError(`failed to persist the minted operator token at ${path}`, {
			cause: err,
			recoveryHint: `make ${dataDir} writable, or export WARREN_API_TOKEN to skip the bootstrap`,
		});
	}
	return { token, source: "minted", path };
}

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
	const base = kind === "public" ? publicReadAuth(operator) : operator;
	// warren-57fd: admit per-run scoped callback tokens (keyed off the same
	// operator token the dispatch-time minter uses) in every non-`--no-auth`
	// mode. The request gate pins each to its own run's callback surface.
	return runScopedAuth(base, token);
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

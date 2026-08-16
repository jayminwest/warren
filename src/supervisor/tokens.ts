/**
 * Validate the burrow auth tokens before spawning anything (warren-d317).
 *
 * Warren and burrow share a unix socket protected by a bearer token. Two
 * env vars wire opposite ends of that one channel:
 *
 *   BURROW_API_TOKEN     — read by `burrow serve`, the token it accepts.
 *   WARREN_BURROW_TOKEN  — read by warren's burrow-client, the token it sends.
 *
 * If either is missing, or they disagree, every dispatch dies with a 401
 * "missing Authorization header" once boot finishes. Worse, if BURROW_API_TOKEN
 * alone is missing, `burrow serve` exits with `[validation_error]` and the
 * supervisor restart-loops it five times before giving up — ten boot-loop
 * lines in the container logs for one missing secret. Validate at the supervisor
 * before anything spawns and exit with a single, pointed error.
 *
 * `WARREN_BURROW_NO_AUTH=1` bypasses validation: burrow serves without
 * auth and warren's client does not need a token. This is the loopback-dev
 * escape hatch from `resolveCommandFromEnv` (see main.ts).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface TokenValidationConfig {
	readonly burrowApiToken: string | undefined;
	readonly warrenBurrowToken: string | undefined;
	readonly noAuth: boolean;
}

export interface TokenValidationResult {
	/** sha256:<12 hex chars> when both tokens validated; null in noAuth mode. */
	readonly fingerprint: string | null;
}

/**
 * Mint the shared in-container secret (warren-8071). Both ends of the
 * warren↔burrow channel live inside the one container the supervisor
 * spawns, so the supervisor generates the token itself at boot and
 * exports it to both children. 256 bits of CSPRNG entropy, hex-encoded.
 */
export function mintSharedBurrowToken(): string {
	return randomBytes(32).toString("hex");
}

export interface EnsureBurrowAuthConfig {
	readonly noAuth: boolean;
}

export interface EnsureBurrowAuthResult {
	readonly fingerprint: string | null;
	/** true when the supervisor minted the token because the operator set neither var. */
	readonly minted: boolean;
}

/**
 * Resolve the burrow auth token pair for this boot, mutating `env` so the
 * values reach both child processes (Bun.spawn inherits process.env).
 *
 * - Both unset (and not noAuth): mint one ephemeral token and export it as
 *   BOTH vars — the standalone self-host path needs no operator secret.
 * - One or both set: fall through to `validateBurrowAuthTokens` unchanged,
 *   so operator-supplied values still win (k8s / split topologies) and a
 *   half-set pair still fails fast instead of silently minting.
 */

/**
 * Thrown by `validateBurrowAuthTokens` when env is misconfigured. Carries a
 * `recoveryHint` so the supervisor can print actionable guidance without the
 * caller having to map message → fix.
 */
export class TokenValidationError extends Error {
	readonly recoveryHint: string;
	constructor(message: string, recoveryHint: string) {
		super(message);
		this.name = "TokenValidationError";
		this.recoveryHint = recoveryHint;
	}
}

export function ensureBurrowAuthTokens(
	env: Record<string, string | undefined>,
	cfg: EnsureBurrowAuthConfig,
	mint: () => string = mintSharedBurrowToken,
): EnsureBurrowAuthResult {
	if (cfg.noAuth) return { fingerprint: null, minted: false };
	const burrow = env.BURROW_API_TOKEN ?? "";
	const warren = env.WARREN_BURROW_TOKEN ?? "";
	if (burrow === "" && warren === "") {
		const token = mint();
		env.BURROW_API_TOKEN = token;
		env.WARREN_BURROW_TOKEN = token;
		return { fingerprint: tokenFingerprint(token), minted: true };
	}
	const validated = validateBurrowAuthTokens({
		burrowApiToken: env.BURROW_API_TOKEN,
		warrenBurrowToken: env.WARREN_BURROW_TOKEN,
		noAuth: false,
	});
	return { fingerprint: validated.fingerprint, minted: false };
}

const SHARED_HINT =
	"Generate one secret and set both vars to it: TOKEN=$(openssl rand -hex 32); export BURROW_API_TOKEN=$TOKEN WARREN_BURROW_TOKEN=$TOKEN. " +
	"On a cluster, put both in the same Secret so they always match. " +
	"For loopback dev only, set WARREN_BURROW_NO_AUTH=1 to skip auth entirely.";

export function validateBurrowAuthTokens(cfg: TokenValidationConfig): TokenValidationResult {
	if (cfg.noAuth) return { fingerprint: null };

	const burrow = cfg.burrowApiToken ?? "";
	const warren = cfg.warrenBurrowToken ?? "";

	if (burrow === "" && warren === "") {
		throw new TokenValidationError(
			"BURROW_API_TOKEN and WARREN_BURROW_TOKEN are not set",
			SHARED_HINT,
		);
	}
	if (burrow === "") {
		throw new TokenValidationError(
			"BURROW_API_TOKEN is not set (WARREN_BURROW_TOKEN is set)",
			"BURROW_API_TOKEN is read by 'burrow serve' inside the supervisor; without it burrow refuses to bind. " +
				SHARED_HINT,
		);
	}
	if (warren === "") {
		throw new TokenValidationError(
			"WARREN_BURROW_TOKEN is not set (BURROW_API_TOKEN is set)",
			"WARREN_BURROW_TOKEN is read by warren's burrow-client; without it every dispatch fails with 401. " +
				SHARED_HINT,
		);
	}
	if (!constantTimeEqualString(burrow, warren)) {
		throw new TokenValidationError(
			"BURROW_API_TOKEN and WARREN_BURROW_TOKEN are set but do not match",
			SHARED_HINT,
		);
	}

	return { fingerprint: tokenFingerprint(burrow) };
}

/**
 * sha256:<first 12 hex chars> — short enough to eyeball in two log lines,
 * long enough that two distinct tokens of any reasonable length collide
 * with negligible probability. Never returns the token itself.
 */
export function tokenFingerprint(token: string): string {
	const hex = createHash("sha256").update(token).digest("hex");
	return `sha256:${hex.slice(0, 12)}`;
}

function constantTimeEqualString(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

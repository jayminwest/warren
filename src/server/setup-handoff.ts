/**
 * One-time browser auth handoff (warren-48f8, pl-26f3 step 3).
 *
 * `warren up` wants the operator's browser tab to land in the SPA already
 * authenticated, without the long-lived operator token ever sitting in a
 * URL or shell history. The mechanism is a single-use, ten-minute setup
 * code minted at boot:
 *
 *   1. `armSetupHandoff` is called ONLY when the boot opts in
 *      (`BootServerOptions.setupHandoff`, set by `warren up` — never by
 *      `warren serve`). It refuses to arm under `WARREN_AUTH=public` and
 *      under `--no-auth`, because in the former the redemption page would
 *      be a credential leak onto a public instance (scenario 39's
 *      guarantee) and in the latter there is no token to hand off.
 *   2. The store keeps `code -> operatorToken` in memory — same posture
 *      as the GitHub App registration nonces (`RegistrationSessions`):
 *      process-local, a restart mid-flow means starting over.
 *   2b. The code is 32 crypto-random bytes, base64url (~256 bits of
 *      entropy — unguessable by any practical brute force inside the TTL).
 *   3. `GET /setup?code=...` (see `src/server/handlers/setup.ts`) redeems
 *      the code EXACTLY ONCE — `redeem` deletes before returning — and
 *      hands the browser the operator token the way the UI already
 *      expects (the `warren.apiToken` localStorage key the login page
 *      writes), then redirects to `/`. A second redemption gets a clean
 *      400 error page pointing at the UI login.
 *
 * The token itself never rides the URL: only the throwaway code does, so
 * browser history holds nothing reusable after the single redemption.
 */

import { randomBytes } from "node:crypto";
import type { AuthKind } from "./auth.ts";
/** Setup codes live ten minutes — long enough for a browser to open. */
export const SETUP_CODE_TTL_MS = 10 * 60 * 1000;

export function defaultSetupCode(): string {
	return randomBytes(32).toString("base64url");
}

/** Callable seam for the logger (pino-compatible). */
export interface SetupHandoffLogger {
	warn(obj: object, msg: string): void;
	info(obj: object, msg: string): void;
}

/**
 * The single-use code store. `mint` records one code bound to the operator
 * token; `redeem` consumes it atomically (delete-then-return, so a second
 * caller racing the first loses). Expired entries are swept on every call.
 */
export class SetupHandoffStore {
	private readonly pending = new Map<string, { token: string; expiresAt: number }>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs: number = SETUP_CODE_TTL_MS,
		private readonly random: () => string = defaultSetupCode,
	) {}

	/** Mint a single-use code bound to `token`; the code is the return value. */
	mint(token: string): string {
		this.sweep();
		const code = this.random();
		this.pending.set(code, { token, expiresAt: this.now() + this.ttlMs });
		return code;
	}

	/**
	 * Redeem `code` exactly once. Returns the bound operator token, or
	 * `null` for an unknown/expired/spent code. Deletion happens before
	 * the return, so concurrent redemptions cannot both win.
	 */
	redeem(code: string): string | null {
		this.sweep();
		const entry = this.pending.get(code);
		if (entry === undefined) return null;
		this.pending.delete(code);
		return entry.token;
	}

	/** Live-code count — exposed for tests and diagnostics. */
	get size(): number {
		this.sweep();
		return this.pending.size;
	}

	private sweep(): void {
		const cutoff = this.now();
		for (const [code, entry] of this.pending) {
			if (entry.expiresAt <= cutoff) this.pending.delete(code);
		}
	}
}

/** The armed result: the store the route reads, plus the boot-time URL pieces. */
export interface ArmedSetupHandoff {
	readonly store: SetupHandoffStore;
	readonly code: string;
}

export interface ArmSetupHandoffInput {
	readonly wanted: boolean;
	readonly noAuth: boolean;
	readonly authKind: AuthKind;
	/** The operator token the redeemed browser session will hold. */
	readonly token: string | undefined;
	readonly logger: SetupHandoffLogger;
	readonly now?: () => number;
	readonly random?: () => string;
}

/**
 * Arm the setup handoff for this boot, or explain (via the logger) why not.
 * Minting happens ONLY here, so an ordinary `warren serve` boot — which
 * never passes `wanted: true` — mints nothing and `/setup` answers 404.
 */
export function armSetupHandoff(input: ArmSetupHandoffInput): ArmedSetupHandoff | undefined {
	if (!input.wanted) return undefined;
	if (input.noAuth) {
		// No token exists to hand off; the UI needs no login under --no-auth.
		input.logger.warn({}, "setup handoff not armed: --no-auth carries no operator token");
		return undefined;
	}
	if (input.authKind === "public") {
		// SECURITY.md: /setup never exists on a WARREN_AUTH=public instance —
		// an anonymous redemption page there would hand a stranger the
		// operator token (scenario 39 guards exactly this class of leak).
		input.logger.warn(
			{},
			"setup handoff refused: WARREN_AUTH=public never arms the browser auth handoff",
		);
		return undefined;
	}
	if (input.token === undefined || input.token === "") {
		input.logger.warn({}, "setup handoff not armed: no operator token resolved at boot");
		return undefined;
	}
	const store = new SetupHandoffStore(input.now, undefined, input.random);
	const code = store.mint(input.token);
	input.logger.info(
		{ ttlMs: SETUP_CODE_TTL_MS },
		"setup handoff armed: single-use /setup code minted",
	);
	return { store, code };
}

/** Build the redemption URL for an armed handoff against the listening URL. */
export function setupRedemptionUrl(baseUrl: string, code: string): string {
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	return `${base}/setup?code=${encodeURIComponent(code)}`;
}

/**
 * The boot-shaped wrapper around `armSetupHandoff` so `bootServer`'s call
 * site stays one line (warren-48f8). `opts` is structural on purpose: the
 * real `BootServerOptions` lives in `server/main/index.ts`, which imports
 * this module — a named import there would be a cycle.
 */
export interface BootHandoffOpts {
	readonly setupHandoff?: boolean;
	readonly noAuth?: boolean;
	readonly now?: () => Date;
}

/**
 * Resolve the operator token (boot mint-or-persist first, env fallback) and
 * arm the handoff when the boot asked for it. Thin: every refusal policy
 * lives in `armSetupHandoff` above.
 */
export function armSetupHandoffFromBoot(
	opts: BootHandoffOpts,
	tokenBoot: { readonly token: string; readonly source: string } | null,
	env: { readonly WARREN_API_TOKEN?: string },
	authKind: AuthKind,
	logger: SetupHandoffLogger,
): ArmedSetupHandoff | undefined {
	return armSetupHandoff({
		wanted: opts.setupHandoff === true,
		noAuth: opts.noAuth === true,
		authKind,
		token: tokenBoot?.token ?? env.WARREN_API_TOKEN,
		logger,
		...(opts.now !== undefined ? { now: () => opts.now?.().getTime() ?? Date.now() } : {}),
	});
}

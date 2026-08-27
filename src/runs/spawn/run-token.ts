/**
 * Per-run, run-scoped callback credential (warren-57fd).
 *
 * Before this, every run sandbox was injected with the instance operator
 * token (`WARREN_API_TOKEN`) — the full-capability bearer that can dispatch
 * runs, delete projects, and read every operator-only body. Any code inside
 * the sandbox (including prompt-injected agent behavior on a public instance,
 * or an attacker-influenced test/build script on a contributed branch) could
 * therefore drive the control plane AS the operator. That is the wrong trust
 * boundary for a sandbox whose inputs are public.
 *
 * The fix mints a credential bound to a SINGLE run at dispatch time and injects
 * THAT instead. A run-scoped token authorizes only the run's own callback
 * surface — `GET /runs/:thisId/inbox`, `GET /runs/:thisId/finalize-intent`,
 * `POST /runs/:thisId/finalize-result`, `POST /runs/:thisId/salvage`,
 * `POST /runs/:thisId/git-credential` (`RUN_CALLBACK_ROUTE_PATTERNS`) — and
 * nothing else, and only for its own
 * run id. Its lifetime is bounded by the
 * run: the server's request gate rejects it once the run reaches a terminal
 * state (see `src/server/server.ts`).
 *
 * The credential is a stateless HMAC over the run id keyed by the instance's
 * base secret (V1: the operator token itself, so no new config or key store is
 * needed and the mint/verify sides share one secret automatically). It carries
 * NO capability of its own — the server re-derives the run id from the
 * signature and gates every request against the narrow route+id+liveness rule.
 *
 * `RunTokenMinter` is the seam a future GitHub App installation-token flow
 * (R-18) implements without touching the injection site: swap the minter, keep
 * `mint(runId): string`. No App/OAuth machinery is built here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Scheme prefix identifying a warren run-scoped credential (v1). */
const RUN_TOKEN_SCHEME = "wrs1";

/**
 * Mints a credential scoped to a single run's callback surface. V1 is
 * `createHmacRunTokenMinter`; a future installation-token flow (R-18)
 * implements the same one-method interface.
 */
export interface RunTokenMinter {
	/** Mint a bearer valid only for `runId`'s own callback routes. */
	mint(runId: string): string;
}

/**
 * The HMAC-over-the-base-secret minter (V1). `secret` is the instance operator
 * token, so the verify side (`src/server/auth.ts`) shares it with no extra
 * wiring. The token is `wrs1.<runId>.<hexHmac>` — self-describing (the server
 * recognizes the scheme cheaply) and stateless (no server-side token store).
 */
export function createHmacRunTokenMinter(secret: string): RunTokenMinter {
	return {
		mint(runId: string): string {
			return `${RUN_TOKEN_SCHEME}.${runId}.${sign(secret, runId)}`;
		},
	};
}

/**
 * Cheap prefix test: does `token` look like a run-scoped credential? Lets the
 * auth provider route to `verifyRunScopedToken` without attempting an HMAC on
 * every operator bearer.
 */
export function isRunScopedToken(token: string): boolean {
	return token.startsWith(`${RUN_TOKEN_SCHEME}.`);
}

/**
 * Verify a run-scoped `token` against `secret`; returns the bound run id on a
 * valid signature, or `null` on any malformed / mismatched token. Constant-time
 * signature comparison. A run id never contains `.` (`run_<base32>`), so the
 * three-way split is unambiguous.
 */
export function verifyRunScopedToken(token: string, secret: string): string | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [scheme, runId, sig] = parts;
	if (scheme !== RUN_TOKEN_SCHEME || !runId || !sig) return null;
	if (!constantTimeEqual(sig, sign(secret, runId))) return null;
	return runId;
}

function sign(secret: string, runId: string): string {
	return createHmac("sha256", secret).update(`${RUN_TOKEN_SCHEME}.${runId}`).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * The ONLY routes a run-scoped credential may reach — a run's own callback
 * surface (the in-pod steering poll, the two finalize legs, the salvage
 * intake, and the App-mode credential remint). The request gate additionally
 * pins the `:id` param to the token's bound run id and refuses once that run
 * is terminal, so this set is necessary but not sufficient on its own.
 *
 * `/runs/:id/salvage` (warren-cd3b) was missing here until warren-7c1e. Its
 * only caller is `finalize-entrypoint.ts`, which posts with the pod's
 * run-scoped `WARREN_API_TOKEN` — so every in-pod salvage POST was refused
 * 403 by this gate and the pod's last recoverable copy of the run's commits
 * died with the `emptyDir`. The route's own doc comment already asserted the
 * pod "carries its per-run scoped callback token"; the allowlist simply was
 * not updated alongside it. Admitting it here keeps the narrow rule intact —
 * a run token still reaches only its OWN run's salvage, and only while that
 * run is live.
 */
export const RUN_CALLBACK_ROUTE_PATTERNS: ReadonlySet<string> = new Set([
	"/runs/:id/inbox",
	"/runs/:id/finalize-intent",
	"/runs/:id/finalize-result",
	"/runs/:id/salvage",
	// warren-5a5c: the K8s App-mode credential remint. Its only caller is
	// `finalize-entrypoint.ts` / `salvage-post.ts` inside the pod, which POST
	// with the pod's run-scoped `WARREN_API_TOKEN` — the same shape as the
	// salvage 403 warren-7c1e fixed. Under App mode a mounted installation
	// token expires long before a run ends, so the pod cannot hold a push
	// credential; it MUST ask the control plane to mint one over this
	// authenticated callback channel (forge-contract.md §4.1 window 3). The
	// handler mints off the boot-resolved forge and returns a fresh, scoped
	// credential — it never echoes or widens the caller's own token — so
	// admitting the route keeps the narrow rule intact: a run token still
	// reaches only its OWN run's remint, and only while that run is live.
	"/runs/:id/git-credential",
]);

/** True iff `pattern` is one of the run-callback routes a run token may reach. */
export function isRunCallbackRoute(pattern: string): boolean {
	return RUN_CALLBACK_ROUTE_PATTERNS.has(pattern);
}

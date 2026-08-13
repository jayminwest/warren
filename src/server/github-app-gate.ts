/**
 * Existence gate for the GitHub App registration HTTP surface
 * (warren-e320): `GET /github-app/register`, `GET /github-app/callback`,
 * and any future route under the `/github-app` prefix — the
 * `/github-app/installed` setup_url return route proposed in warren-54c7
 * must ride this same gate, which is why the gate matches on the PREFIX
 * (`buildApiRoutes` in `src/server/handlers/route-table.ts`) rather than
 * naming the two routes that exist today.
 *
 * Why the surface is gated at all: both routes are `anonymous` policy (no
 * bearer rides a browser navigation or a GitHub redirect), so on a
 * `WARREN_AUTH=public` instance a stranger could mint unbounded nonces in
 * the process-local `RegistrationSessions` store and drive one outbound
 * `POST /app-manifests/{code}/conversions` from warren's egress per nonce.
 * There is no credential disclosure (a visitor's App is their own) and no
 * warren state change beyond the nonce store — the gate closes the ABUSE
 * vector, not a leak.
 *
 * Resolution, ONCE at boot exactly like `WARREN_AUTH` (`resolveAuthKind`):
 *
 *   - Explicit `WARREN_GITHUB_APP_REGISTRATION=on|off` wins outright.
 *   - Otherwise the default derives FAIL-SAFE:
 *       OFF when `WARREN_AUTH=public` (a stranger-reachable instance keeps
 *         no registration surface),
 *       OFF when `WARREN_FORGE=app` (App credentials are already
 *         configured — the flow has served its one purpose; a malformed
 *         `app` config fails boot louder earlier, so `app` selected means
 *         `app` configured),
 *       ON only for a private instance without App credentials — the
 *         first-boot case the flow exists for.
 *   - An unrecognized explicit value throws `ValidationError` (fail loud,
 *     never silently default — the same posture as `WARREN_AUTH`).
 *
 * Gated-off routes answer 404, NOT 401/403: the route ceases to exist,
 * preserving the public-mode invariant acceptance scenario 39 guards (a
 * spectator route never answers 401/403).
 */

import { ValidationError } from "../core/errors.ts";
import { resolveForgeKind } from "../forge/registry.ts";
import { resolveAuthKind } from "./auth.ts";
import type { Logger } from "./types.ts";

/** The explicit override knob. `on`/`off`, case-insensitive. */
export const GITHUB_APP_REGISTRATION_ENV = "WARREN_GITHUB_APP_REGISTRATION";

/** Minimal env surface the resolver reads. */
export type GitHubAppRegistrationGateEnv = Readonly<Record<string, string | undefined>>;

/**
 * The boot-resolved verdict, threaded onto `ServerDeps` and consumed by
 * `buildApiRoutes`. `reason` is the human-readable derivation, logged at
 * startup so an operator can see WHY the surface is or isn't there.
 */
export interface GitHubAppRegistrationGate {
	readonly enabled: boolean;
	readonly reason: string;
}

/**
 * Resolve the gate for this process — call ONCE at boot. See the module
 * doc for the derivation matrix.
 */
export function resolveGitHubAppRegistrationGate(
	env: GitHubAppRegistrationGateEnv = process.env,
): GitHubAppRegistrationGate {
	const raw = env[GITHUB_APP_REGISTRATION_ENV]?.trim().toLowerCase();
	if (raw === "on") {
		return { enabled: true, reason: `explicit ${GITHUB_APP_REGISTRATION_ENV}=on` };
	}
	if (raw === "off") {
		return { enabled: false, reason: `explicit ${GITHUB_APP_REGISTRATION_ENV}=off` };
	}
	if (raw !== undefined && raw !== "") {
		throw new ValidationError(`Unknown ${GITHUB_APP_REGISTRATION_ENV} "${raw}"`, {
			recoveryHint: `Set ${GITHUB_APP_REGISTRATION_ENV} to "on" or "off" (or leave it unset for the fail-safe default).`,
		});
	}
	if (resolveAuthKind(env) === "public") {
		return {
			enabled: false,
			reason:
				"default off: WARREN_AUTH=public — a stranger-reachable instance keeps no anonymous registration surface",
		};
	}
	if (resolveForgeKind(env) === "app") {
		return {
			enabled: false,
			reason:
				"default off: WARREN_FORGE=app is already configured — the registration flow has served its one purpose",
		};
	}
	return {
		enabled: true,
		reason:
			"default on: private instance without App credentials — the first-boot case the flow exists for",
	};
}

/**
 * Boot composition helper: resolve the gate ONCE and log the verdict so an
 * operator can see WHY the surface is or isn't there (warren-e320). Kept
 * out of `bootServer`'s orchestrator, which rides the 500-line file budget.
 */
export function bootGitHubAppRegistrationGate(
	env: GitHubAppRegistrationGateEnv,
	logger: Logger,
): GitHubAppRegistrationGate {
	const gate = resolveGitHubAppRegistrationGate(env);
	logger.info(
		{ enabled: gate.enabled, reason: gate.reason },
		"github app registration gate resolved",
	);
	return gate;
}

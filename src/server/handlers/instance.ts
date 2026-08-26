/**
 * Instance facts handler (warren-2eec / pl-7e38 step 17) — `GET /instance`.
 *
 * A thin surface over `src/instance/facts.ts`: the domain module owns the
 * projection rules; this handler only resolves the process-level inputs
 * (env, boot-resolved auth kind, db dialect, live uptime) and applies the
 * public reduction. Read-only by construction — there is no mutable
 * server-side settings state to expose.
 */

import { buildInstanceFacts, type InstanceEnv, publicInstanceFacts } from "../../instance/facts.ts";
import { type AuthEnv, resolveAuthKind } from "../auth.ts";
import { isPublicOnly } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

/**
 * `GET /instance` — boot-time instance facts for the operator console.
 *
 * Policy is `readPublic`, and the body varies with `Authorization`: an
 * operator gets the full facts (db backend, uptime, K8s admission caps),
 * a `WARREN_AUTH=public` spectator gets the reduced static projection
 * (`version`, `runtime`, `authMode`). Never secrets, tokens, connection
 * strings, internal hostnames, or filesystem paths — the domain module's
 * allowlist makes that a structural guarantee, and the acceptance public
 * leak guard (scenario 39) polices the whole mode.
 */
export function instanceFactsHandler(
	deps: ServerDeps,
	env: AuthEnv & InstanceEnv = process.env,
): RouteHandler {
	return (ctx) => {
		const facts = buildInstanceFacts({
			env,
			authMode: resolveAuthKind(env),
			dbBackend: deps.db?.dialect ?? null,
			uptimeSeconds: process.uptime(),
		});
		// Body varies with Authorization; Vary keeps a shared cache from
		// serving the operator body to an anonymous visitor.
		return jsonResponse(200, isPublicOnly(ctx.actor) ? publicInstanceFacts(facts) : facts, {
			headers: { vary: "Authorization" },
		});
	};
}

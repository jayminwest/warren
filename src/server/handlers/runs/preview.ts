import { ValidationError } from "../../../core/errors.ts";
import { createRunPreviewsRepo } from "../../../preview/eviction/index.ts";
import { teardownPreview } from "../../../preview/teardown.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { optionalString, readJsonBodyOrEmpty, requireParam } from "../index.ts";

function validatePreviewConfig(deps: ServerDeps, mode: "subdomain" | "path"): void {
	if (deps.previewAuth === undefined) {
		throw new ValidationError("preview surface is not configured on this warren", {
			recoveryHint:
				"ensure WARREN_API_TOKEN is set (and WARREN_PREVIEW_HOST when WARREN_PREVIEW_MODE=subdomain) to enable per-run previews",
		});
	}
	if (mode === "subdomain" && deps.previewHost === undefined) {
		throw new ValidationError("preview surface is not configured on this warren", {
			recoveryHint:
				"set WARREN_PREVIEW_HOST to enable subdomain-mode previews, or switch to WARREN_PREVIEW_MODE=path",
		});
	}
}

/**
 * `GET /runs/:id/preview/login?token=<bearer>&redirect=<absolute-url>`
 * (R-19 / SPEC §11.L, warren-8a10; path-mode redirect warren-edff;
 * per-run cookie name warren-63e1).
 *
 * The signed-cookie handshake the preview proxy depends on. A browser
 * hitting a preview origin directly can't carry an Authorization header,
 * so the operator opens this URL on the warren host, the handler
 * validates the bearer in the query, sets a scoped `warren_preview*`
 * cookie, and 302s to the preview.
 *
 *   - **Subdomain mode** (`deps.previewMode === "subdomain"`): cookie name
 *     `warren_preview`, `Domain=.<host>; Path=/`; redirect must be
 *     `https://run-<id>.<previewHost>/...`.
 *   - **Path mode** (default; `deps.previewMode === "path"`): cookie name
 *     `warren_preview_<runId>` (per-run literal suffix, warren-63e1),
 *     `Path=/` with no `Domain`; redirect must be same-origin as the
 *     inbound request and live under `/p/<id>/`. The cookie ships on
 *     every same-origin request so referer-based asset routing in the
 *     proxy preamble can authenticate sub-resource loads.
 *
 * This route is auth-exempt (`isAuthExempt` whitelists `/preview/login`)
 * because the standard bearer gate would 401 the browser before the
 * handler ever ran. The handler does its own bearer check via
 * `previewAuth.verifyLoginToken` (constant-time compare against the
 * configured `WARREN_API_TOKEN`).
 *
 * `redirect` is constrained to the run's own preview surface — anything
 * else is rejected so a stolen login link can't become an open redirect.
 *
 * 400 when `previewAuth` is null (subdomain mode with no host, or
 * warren booted with `--no-auth`); the proxy is also disabled in those
 * configurations so the handshake has nothing to issue against.
 */
export function previewLoginHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const runId = requireParam(ctx, "id");
		const mode: "subdomain" | "path" = deps.previewMode ?? "subdomain";
		validatePreviewConfig(deps, mode);

		const token = ctx.url.searchParams.get("token");
		// biome-ignore lint/style/noNonNullAssertion: checked by validatePreviewConfig
		if (!deps.previewAuth!.verifyLoginToken(token)) {
			return jsonResponse(401, {
				error: {
					code: "unauthorized",
					message: "preview login requires a valid ?token=<WARREN_API_TOKEN>",
				},
			});
		}
		// 404 fast if the run isn't known — issuing a cookie for a nonexistent
		// run would let an attacker pre-seed a session keyed off a future id.
		await deps.repos.runs.require(runId);

		const redirect = ctx.url.searchParams.get("redirect");
		const redirectTarget =
			mode === "path"
				? resolvePathPreviewRedirect(redirect, runId, ctx.url.origin)
				: resolveSubdomainPreviewRedirect(redirect, runId, deps.previewHost as string);
		if (redirectTarget === null) {
			const hint =
				mode === "path"
					? `redirect must be a same-origin URL under ${ctx.url.origin}/p/${runId}/`
					: `redirect must be an absolute URL under https://run-${runId}.${deps.previewHost}/`;
			return jsonResponse(400, {
				error: {
					code: "preview_redirect_invalid",
					message: hint,
				},
			});
		}

		const now = deps.now?.() ?? new Date();
		// biome-ignore lint/style/noNonNullAssertion: checked by validatePreviewConfig
		const cookie = deps.previewAuth!.signCookie(runId, now);
		return new Response(null, {
			status: 302,
			headers: {
				location: redirectTarget,
				"set-cookie": cookie.setCookieHeader,
			},
		});
	};
}

function resolveSubdomainPreviewRedirect(
	raw: string | null,
	runId: string,
	host: string,
): string | null {
	const fallback = `https://run-${runId}.${host}/`;
	if (raw === null || raw.length === 0) return fallback;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	if (parsed.hostname !== `run-${runId}.${host}`) return null;
	return parsed.toString();
}

function resolvePathPreviewRedirect(
	raw: string | null,
	runId: string,
	inboundOrigin: string,
): string | null {
	const fallback = `${inboundOrigin}/p/${runId}/`;
	if (raw === null || raw.length === 0) return fallback;
	let parsed: URL;
	try {
		// Relative URLs (`/p/<id>/foo`) resolve against the inbound origin so
		// callers don't have to know the scheme/host upfront. Absolute URLs are
		// then origin-checked below.
		parsed = new URL(raw, inboundOrigin);
	} catch {
		return null;
	}
	if (parsed.origin !== inboundOrigin) return null;
	if (!parsed.pathname.startsWith(`/p/${runId}/`)) return null;
	return parsed.toString();
}

/**
 * `POST /runs/:id/preview/teardown` (R-19 / SPEC §11.L acceptance #8,
 * warren-d725).
 *
 * Idempotent operator-driven teardown of the per-run preview. Bearer-
 * required (the global auth gate covers `/runs/*`; this route is not
 * in `isAuthExempt`). The body is optional — `{actor}` is forwarded
 * onto the audit event for attribution, defaulting to `"manual"`.
 *
 * Responds 200 on every CAS outcome (`torn-down`, `already-torn-down`,
 * `already-failed`, `never-launched`); 404 on unknown runId; 503 when
 * `deps.db` is undefined (no repo layer wired). Works on both sqlite
 * and postgres dialects — `createRunPreviewsRepo` is dialect-
 * polymorphic (warren-adfb), so the eviction-worker CAS path that
 * teardown rides on is already exercised on pg in production. The
 * route is `tornDown: true` only when the call actually flipped a
 * `starting`/`live` row.
 */
export function previewTeardownHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const runId = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const actor = body !== null ? optionalString(body, "actor") : undefined;

		if (deps.db === undefined) {
			return jsonResponse(503, {
				error: {
					code: "preview_teardown_unavailable",
					message: "preview teardown requires the repo layer; this warren has no db handle wired",
				},
			});
		}

		const previews = createRunPreviewsRepo(deps.db);
		const result = await teardownPreview({
			runId,
			repos: deps.repos,
			previews,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(actor !== undefined ? { actor } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			logger: teardownLoggerFor(deps),
		});

		return jsonResponse(200, {
			status: result.status,
			tornDown: result.tornDown,
			previousState: result.previousState,
			port: result.port,
		});
	};
}

/**
 * Narrow `ServerDeps.logger` (the pino-shaped surface) onto the
 * `Record<string, unknown>` signature the preview teardown / eviction
 * code expects. Same shape the boot path already builds for the
 * eviction worker — kept inline here to avoid threading another
 * `*LoggerFromPino` adapter down through `ServerDeps`.
 */
function teardownLoggerFor(deps: ServerDeps): {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
} {
	return {
		info: (obj, msg) => deps.logger.info(obj, msg),
		warn: (obj, msg) => deps.logger.warn(obj, msg),
		error: (obj, msg) => deps.logger.error(obj, msg),
	};
}

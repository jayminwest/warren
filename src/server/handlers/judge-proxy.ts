/**
 * Judge export proxy — `GET /extensions/judge/verdicts.jsonl`
 * (warren-1b40).
 *
 * The judge extension is a separate process/Service with its own
 * bearer credential (`JUDGE_EXPORT_TOKEN`), and warren's CSP is
 * `connect-src 'self'` on every response, so the browser can never
 * fetch the judge directly. This route reverse-proxies the judge's
 * `/verdicts.jsonl` export: the judge base URL and the export token
 * live server-side in env (`WARREN_JUDGE_BASE_URL` /
 * `WARREN_JUDGE_EXPORT_TOKEN`) and never reach the client.
 *
 * The extensions seam holds — this module speaks HTTP to whatever URL
 * the operator configured; it imports nothing from `extensions/`.
 *
 * Env is read from `process.env` per request, mirroring the
 * `diagnostics.ts` probes: boot validates nothing here, tests override
 * env freely, and an unconfigured instance gets an honest 501 the
 * client can classify as "not deployed" — never the SPA fallback.
 */

import { jsonResponse, SECURITY_HEADERS } from "../response.ts";
import type { RouteHandler } from "../types.ts";

const NDJSON_CT = "application/x-ndjson";

/**
 * Proxy `GET /extensions/judge/verdicts.jsonl` to the judge extension.
 * Query params (`since`, `limit`) are forwarded verbatim; the judge's
 * `X-Verdicts-Max-Id` cursor header is passed back through.
 */
export function judgeVerdictsProxyHandler(): RouteHandler {
	return async (ctx) => {
		const baseUrl = process.env.WARREN_JUDGE_BASE_URL;
		const token = process.env.WARREN_JUDGE_EXPORT_TOKEN;
		if (!baseUrl || !token) {
			return jsonResponse(501, {
				error: {
					code: "judge_not_configured",
					message: "the judge export proxy is not configured on this instance",
					hint: "set WARREN_JUDGE_BASE_URL and WARREN_JUDGE_EXPORT_TOKEN to enable it",
				},
			});
		}
		const upstream = new URL("/verdicts.jsonl", baseUrl);
		upstream.search = ctx.url.search;
		let upstreamRes: Response;
		try {
			upstreamRes = await fetch(upstream, {
				method: "GET",
				headers: { authorization: `Bearer ${token}` },
			});
		} catch (err) {
			ctx.logger.warn(
				{ err, upstream: upstream.origin },
				"judge export proxy: upstream unreachable",
			);
			return jsonResponse(502, {
				error: {
					code: "judge_unreachable",
					message: "the judge export endpoint is unreachable",
				},
			});
		}
		if (!upstreamRes.ok) {
			// Never forward the upstream body — it can echo the credential
			// handshake. Status is summarized, not passed through.
			ctx.logger.warn(
				{ status: upstreamRes.status },
				"judge export proxy: upstream returned a non-200 status",
			);
			return jsonResponse(502, {
				error: {
					code: "judge_export_failed",
					message: "the judge export endpoint rejected the request",
				},
			});
		}
		const headers: Record<string, string> = {
			"content-type": upstreamRes.headers.get("content-type") ?? NDJSON_CT,
			...SECURITY_HEADERS,
		};
		const maxId = upstreamRes.headers.get("x-verdicts-max-id");
		if (maxId !== null) headers["x-verdicts-max-id"] = maxId;
		return new Response(upstreamRes.body, { status: 200, headers });
	};
}

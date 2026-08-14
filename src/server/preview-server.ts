/**
 * Dedicated path-mode preview listener (warren-3f8a).
 *
 * Path-mode previews used to ride the warren origin at `/p/<runId>/`,
 * which put agent-authored preview code on the same browser origin as
 * the warren UI — and the UI keeps the operator bearer token in
 * localStorage, which any same-origin script can read. This listener
 * gives previews their own origin: same hostname, dedicated port
 * (`WARREN_PREVIEW_PORT`, default bind port + 1). The browser's
 * same-origin policy then walls the preview off from the UI's storage,
 * while the host-scoped signed preview cookie keeps flowing (cookies
 * ignore ports; `SameSite=Lax` is a site check, and ports don't split
 * a site).
 *
 * The listener serves NOTHING but the preview proxy: no API routes, no
 * SPA shell, no auth gate to bypass. A request the proxy doesn't
 * recognize gets a bare JSON 404.
 */

import { previewError } from "../preview/proxy/responses.ts";
import { errorLogFields, renderError } from "./errors.ts";
import { bindRequestIdLogger, extractOrGenerateRequestId, stampRequestId } from "./request-id.ts";
import { jsonResponse, withSecurityHeaders } from "./response.ts";
import { DEFAULT_IDLE_TIMEOUT_SECONDS } from "./server.ts";
import type { Logger, PreviewProxyHandler, ServeHandle, Transport } from "./types.ts";

export interface PreviewServerOptions {
	readonly hostname: string;
	/** TCP port to bind. 0 binds an ephemeral port (tests / ephemeral main port). */
	readonly port: number;
	readonly proxy: PreviewProxyHandler;
	readonly logger: Logger;
	/**
	 * Per-request idle timeout in seconds. Matches the main listener's
	 * bounded default; 0 disables it. This origin has no streaming route of
	 * its own, so nothing here opts out (warren-a676).
	 */
	readonly idleTimeout?: number;
}

/**
 * Boot the preview listener. Mirrors `startServer`'s per-request
 * plumbing (request-id, access log, security-header stamp) without the
 * auth gate or route table — the proxy's signed-cookie check is the
 * only admission control this origin has, exactly like the preamble
 * mounting it replaced.
 */
export function startPreviewServer(opts: PreviewServerOptions): ServeHandle {
	const idleTimeout = opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
	const logger = opts.logger;

	const fetchHandler = async (request: Request): Promise<Response> => {
		const requestId = extractOrGenerateRequestId(request);
		const requestLogger = bindRequestIdLogger(logger, requestId);
		const startedAt = performance.now();
		const url = new URL(request.url);
		let response: Response;
		try {
			const proxied = await opts.proxy(request, url);
			response =
				proxied !== null
					? withSecurityHeaders(proxied)
					: withSecurityHeaders(
							previewError(
								404,
								"preview_not_found",
								"this origin serves only run previews under /p/<run-id>/",
							),
						);
		} catch (err) {
			const rendered = renderError(err, requestId);
			requestLogger.error(
				{ ...errorLogFields(err), route: "preview listener", status: rendered.status },
				"preview server: proxy threw",
			);
			response = jsonResponse(
				rendered.status,
				rendered.envelope,
				rendered.headers !== undefined ? { headers: rendered.headers } : undefined,
			);
		}
		requestLogger.info(
			{
				method: request.method,
				path: url.pathname,
				status: response.status,
				duration_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
			},
			"preview.request",
		);
		return stampRequestId(response, requestId);
	};

	const server = Bun.serve({
		hostname: opts.hostname,
		port: opts.port,
		fetch: fetchHandler,
		idleTimeout,
	});

	const transport: Transport = {
		kind: "tcp",
		hostname: server.hostname ?? opts.hostname,
		port: server.port ?? opts.port,
	};
	return {
		transport,
		url: `http://${transport.hostname}:${transport.port}`,
		stop: async () => {
			server.stop(true);
		},
	};
}

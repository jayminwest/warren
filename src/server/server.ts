/**
 * `Bun.serve` wrapper. Owns the request → auth → router → handler →
 * response pipeline plus the lifecycle (start/stop). Two transport
 * modes: TCP (canonical V1 deploy, fronted by Caddy/Fly edge) and
 * unix socket (forward-compat for any future "warren next to a
 * reverse proxy on the same box" topology). Auth is an opaque
 * `AuthProvider` the caller injects; the dispatch layer never inspects
 * token values.
 *
 * Auth exemption (see `isAuthExempt` in handlers/index.ts): `/healthz` plus
 * every non-API path (SPA shell, static assets, React Router deep
 * links) — otherwise a fresh browser can't reach `Login.tsx` to enter
 * its bearer token. `/readyz` and the rest of the API stay gated;
 * `/readyz` reveals failed checks, which is sensitive in a
 * misconfigured deploy.
 *
 * `startServer` does NOT own the bridges, broker, or DB — those live in
 * `ServerDeps` so a single test can spin up the wire layer without a
 * real burrow socket. The `main.ts` boot wires the production deps.
 */

import { existsSync, unlinkSync } from "node:fs";
import { NO_AUTH } from "./auth.ts";
import { methodNotAllowed, notFound, renderError } from "./errors.ts";
import { buildApiRoutes, isApiPath, isAuthExempt } from "./handlers/index.ts";
import { bindRequestIdLogger, extractOrGenerateRequestId, stampRequestId } from "./request-id.ts";
import { jsonResponse } from "./response.ts";
import { matchRoute, pathExists } from "./router.ts";
import type {
	AuthDenied,
	AuthProvider,
	Logger,
	PreviewProxyHandler,
	Route,
	RouteContext,
	ServeHandle,
	ServeOptions,
	ServerDeps,
	Transport,
} from "./types.ts";
import { createUiHandler } from "./ui.ts";

type ServeServer = ReturnType<typeof Bun.serve>;

const DEFAULT_TRANSPORT: Transport = { kind: "tcp", hostname: "127.0.0.1", port: 0 };

/**
 * Bun.serve's per-request idleTimeout defaults to 10 seconds; that
 * silently kills the long-lived NDJSON stream behind
 * `GET /runs/:id/events?follow=1` whenever the agent has a quiet stretch
 * (warren-b8fc). 0 disables the per-request timeout — every other route
 * here completes in milliseconds, so a server-wide disable is safe and
 * keeps the streaming surface honest.
 */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 0;

/**
 * Boot the wire layer for a fully-wired `ServerDeps`. The serving side
 * owns no state of its own beyond its `Bun.serve` instance — DB, repos,
 * broker, and bridges live in `deps` and outlive the server.
 */
export function startServer(deps: ServerDeps, opts: ServeOptions = {}): ServeHandle {
	const logger = opts.logger ?? deps.logger;
	const routes = opts.routes ?? buildAllRoutes(deps);
	const auth = opts.auth ?? NO_AUTH;
	const transport = opts.transport ?? DEFAULT_TRANSPORT;
	const idleTimeout = opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
	const previewProxy = opts.previewProxy;

	const fetchHandler = async (request: Request): Promise<Response> => {
		// X-Request-ID middleware (warren-30af / pl-7b06 step 19): mint or
		// adopt a correlation id, thread it through the handler pipeline,
		// and stamp it onto every outgoing response — regardless of which
		// branch (handler, error, auth deny, preview proxy, UI fallback)
		// produced the Response.
		const requestId = extractOrGenerateRequestId(request);
		const requestLogger = bindRequestIdLogger(logger, requestId);
		const startedAt = performance.now();
		const response = await handleRequest(
			request,
			routes,
			auth,
			requestLogger,
			previewProxy,
			requestId,
		);
		// Access log (warren-26c2 / pl-f700 step 4): one info line per
		// request. request_id is already bound onto requestLogger, so the
		// correlation id rides along without re-threading it here.
		const url = new URL(request.url);
		requestLogger.info(
			{
				method: request.method,
				path: url.pathname,
				status: response.status,
				duration_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
			},
			"server.request",
		);
		return stampRequestId(response, requestId);
	};

	const server =
		transport.kind === "unix"
			? bindUnix(transport.path, fetchHandler, idleTimeout)
			: bindTcp(transport.hostname, transport.port, fetchHandler, idleTimeout);

	const resolvedTransport: Transport =
		transport.kind === "unix"
			? transport
			: {
					kind: "tcp",
					hostname: server.hostname ?? transport.hostname,
					port: server.port ?? transport.port,
				};

	return {
		transport: resolvedTransport,
		url: formatUrl(resolvedTransport),
		stop: async () => {
			server.stop(true);
			if (resolvedTransport.kind === "unix") {
				try {
					if (existsSync(resolvedTransport.path)) unlinkSync(resolvedTransport.path);
				} catch {
					// Bun normally cleans up the socket inode itself; tolerate races.
				}
			}
		},
	};
}

/**
 * Build the full route table: API routes first, then a UI catch-all
 * if `deps.uiDistDir` is set. Order matters — the UI handler returns
 * the SPA `index.html` for unknown GETs, so it MUST come last.
 *
 * The UI catch-all is registered as `GET /*` and matched by a regex
 * inside the UI handler itself rather than via the router (the
 * router's `:foo` syntax doesn't model "match anything"). Keeping the
 * UI logic out of the router keeps the route table easy to read.
 */
function buildAllRoutes(deps: ServerDeps): Route[] {
	const routes = [...buildApiRoutes(deps)];
	if (deps.uiDistDir !== null) {
		routes.push({
			method: "GET",
			pattern: "/",
			handler: createUiHandler({ distDir: deps.uiDistDir }),
		});
	}
	return routes;
}

function bindTcp(
	hostname: string,
	port: number,
	fetch: (req: Request) => Promise<Response>,
	idleTimeout: number,
): ServeServer {
	return Bun.serve({ hostname, port, fetch, idleTimeout });
}

function bindUnix(
	path: string,
	fetch: (req: Request) => Promise<Response>,
	idleTimeout: number,
): ServeServer {
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {
			// Let Bun.serve produce the canonical error if the path can't be cleared.
		}
	}
	// bun-types' XOR(HostnamePortServeOptions, UnixServeOptions) declares
	// `idleTimeout` only on the TCP variant; Bun's runtime accepts it on
	// the unix variant too. Double cast keeps both transports honest
	// under the same idleTimeout policy (warren-b8fc).
	const opts = { unix: path, fetch, idleTimeout } as unknown as Parameters<typeof Bun.serve>[0];
	return Bun.serve(opts);
}

function formatUrl(transport: Transport): string {
	return transport.kind === "unix"
		? `unix://${transport.path}`
		: `http://${transport.hostname}:${transport.port}`;
}

async function handleRequest(
	request: Request,
	routes: readonly Route[],
	auth: AuthProvider,
	logger: Logger,
	previewProxy: PreviewProxyHandler | undefined,
	requestId: string,
): Promise<Response> {
	const url = new URL(request.url);

	// Preview proxy preamble (R-19 / SPEC §11.L, warren-8a10) runs BEFORE the
	// auth gate: previews use signed-cookie auth keyed off Host, not the
	// bearer header the API gate inspects. Returns null when the request
	// isn't for a preview subdomain — the standard pipeline takes over.
	if (previewProxy !== undefined) {
		try {
			const proxied = await previewProxy(request, url);
			if (proxied !== null) return proxied;
		} catch (err) {
			const rendered = renderError(err);
			logger.error(
				{ err, route: "preview proxy", status: rendered.status },
				"server: preview proxy threw",
			);
			return jsonResponse(rendered.status, rendered.envelope);
		}
	}

	if (!isAuthExempt(url.pathname)) {
		const result = auth.authorize(request);
		if (!result.ok) return denyResponse(result, logger, request, url);
	}

	const match = matchRoute(routes, request.method, url.pathname);
	if (match) {
		const ctx: RouteContext = {
			request,
			url,
			params: match.params,
			logger,
			requestId,
		};
		try {
			return await match.route.handler(ctx);
		} catch (err) {
			const rendered = renderError(err);
			logger.error(
				{
					err,
					route: `${match.route.method} ${match.route.pattern}`,
					status: rendered.status,
				},
				"server: handler threw",
			);
			return jsonResponse(rendered.status, rendered.envelope);
		}
	}

	// No match. Any path under an API prefix must return a canonical JSON
	// 404 envelope rather than leaking the SPA HTML shell — this is the
	// single chokepoint that guarantees that contract regardless of UI
	// handler state (see plan pl-230a / warren-635d).
	if (isApiPath(url.pathname)) {
		const rendered = pathExists(routes, url.pathname)
			? methodNotAllowed(request.method, url.pathname)
			: notFound(url.pathname);
		return jsonResponse(rendered.status, rendered.envelope);
	}

	// If the route is a GET with a UI handler available, fall
	// through to the SPA index — that's how the UI's deep-link routes
	// (`/projects/abc`, `/runs/xyz`) hit the React shell. We model this
	// by checking whether a `GET /` UI route exists in the table.
	const uiFallback =
		request.method.toUpperCase() === "GET"
			? routes.find((r) => r.pattern === "/" && r.method === "GET")
			: undefined;
	if (uiFallback !== undefined) {
		const ctx: RouteContext = {
			request,
			url,
			params: {},
			logger,
			requestId,
		};
		try {
			return await uiFallback.handler(ctx);
		} catch (err) {
			const rendered = renderError(err);
			logger.error(
				{ err, route: "GET (ui fallback)", status: rendered.status },
				"server: ui handler threw",
			);
			return jsonResponse(rendered.status, rendered.envelope);
		}
	}

	const rendered = pathExists(routes, url.pathname)
		? methodNotAllowed(request.method, url.pathname)
		: notFound(url.pathname);
	return jsonResponse(rendered.status, rendered.envelope);
}

function denyResponse(result: AuthDenied, logger: Logger, request: Request, url: URL): Response {
	// Auth-denial log (warren-26c2 / pl-f700 step 4): warn on every
	// rejected request so blocked traffic is visible without leaking the
	// presented token. request_id is bound onto the logger upstream.
	logger.warn(
		{
			method: request.method,
			path: url.pathname,
			status: result.status,
			code: result.code,
		},
		"server.auth_denied",
	);
	const envelope = {
		error: { code: result.code, message: result.message },
	};
	const init: ResponseInit = {};
	if (result.challenge !== undefined) {
		init.headers = { "www-authenticate": result.challenge };
	}
	return jsonResponse(result.status, envelope, init);
}

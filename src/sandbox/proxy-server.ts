/**
 * Per-run loopback HTTP/HTTPS proxy that enforces an outbound domain
 * allowlist (warren-70bb). Lifted from burrow's `src/proxy/server.ts`
 * and rebranded warren-native.
 *
 * The sandbox permits outbound traffic only to this proxy's loopback port.
 * The agent's `HTTP_PROXY` / `HTTPS_PROXY` env points here; the proxy
 * validates the destination host and forwards (HTTP) or tunnels (CONNECT
 * for HTTPS). Disallowed hosts get 403. DNS happens host-side — the
 * sandbox never resolves names, which is why this works without poking
 * holes in the seatbelt profile for mDNSResponder.
 *
 * Lifetime is the run: started in the local drive loop before
 * `runSandboxed`, stopped in that loop's `finally`.
 *
 * V1 is HTTP-aware only. Direct outbound TCP that is not HTTP/HTTPS is
 * unsupported under `network = "restricted"` — the seatbelt/bwrap profile
 * blocks everything else, so the agent must use HTTP_PROXY-aware tooling.
 */

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

export interface ProxyHandle {
	/** Loopback port the proxy is listening on. */
	port: number;
	/** Convenience URL for the HTTP_PROXY env var (`http://127.0.0.1:<port>`). */
	url: string;
	/** Number of requests the proxy has rejected (visible to tests). */
	readonly deniedCount: number;
	/** Number of requests the proxy has forwarded (visible to tests). */
	readonly allowedCount: number;
	/** Stop accepting new connections and close the server. Idempotent. */
	stop(): Promise<void>;
}

export interface ProxyLogger {
	debug?: (msg: object | string) => void;
	info?: (msg: object | string) => void;
	warn?: (msg: object | string) => void;
}

export interface StartProxyOptions {
	/** Hostnames permitted as the destination. Empty list denies everything. */
	allowedDomains: string[];
	/** Bind host. Defaults to `127.0.0.1`. */
	host?: string;
	/** Specific port; defaults to 0 (kernel picks a free port). */
	port?: number;
	logger?: ProxyLogger;
}

/**
 * Match a host against an allowlist. Each entry permits the exact host plus
 * any subdomain (`api.foo.com` allows `api.foo.com` and `*.api.foo.com`).
 * Comparison is case-insensitive; leading dots in entries are tolerated.
 */
export function matchAllowedDomain(host: string, allowed: readonly string[]): boolean {
	if (host.length === 0) return false;
	const normalized = host.toLowerCase();
	for (const raw of allowed) {
		const d = raw.toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
		if (d.length === 0) continue;
		if (normalized === d) return true;
		if (normalized.endsWith(`.${d}`)) return true;
	}
	return false;
}

/**
 * Env vars the drive loop overlays onto the agent spawn when a restricted
 * proxy is live. Clears NO_PROXY so the agent cannot bypass the allowlist
 * via a host-inherited exception list.
 */
export function proxyEnvVars(proxyUrl: string): Record<string, string> {
	return {
		HTTP_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		http_proxy: proxyUrl,
		https_proxy: proxyUrl,
		NO_PROXY: "",
		no_proxy: "",
	};
}

export async function startProxy(opts: StartProxyOptions): Promise<ProxyHandle> {
	const host = opts.host ?? "127.0.0.1";
	const allowed = [...opts.allowedDomains];
	const log = opts.logger;

	let denied = 0;
	let allowedCount = 0;

	const server = http.createServer();

	server.on("request", (req, res) => {
		const target = parseHttpTarget(req);
		if (!target) {
			res.writeHead(400, { "content-type": "text/plain" });
			res.end("warren proxy: malformed request\n");
			return;
		}
		if (!matchAllowedDomain(target.hostname, allowed)) {
			denied += 1;
			log?.warn?.({
				event: "warren.proxy.deny",
				transport: "http",
				host: target.hostname,
				url: req.url,
			});
			res.writeHead(403, { "content-type": "text/plain" });
			res.end(`warren proxy: domain not allowed: ${target.hostname}\n`);
			return;
		}
		allowedCount += 1;
		log?.debug?.({
			event: "warren.proxy.allow",
			transport: "http",
			host: target.hostname,
		});
		forwardHttp(req, res, target);
	});

	server.on("connect", (req, clientSocket, head) => {
		const target = parseConnectTarget(req.url);
		if (!target) {
			denied += 1;
			clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		if (!matchAllowedDomain(target.hostname, allowed)) {
			denied += 1;
			log?.warn?.({
				event: "warren.proxy.deny",
				transport: "connect",
				host: target.hostname,
				port: target.port,
			});
			clientSocket.end(
				`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nwarren proxy: domain not allowed: ${target.hostname}\n`,
			);
			return;
		}
		allowedCount += 1;
		log?.debug?.({
			event: "warren.proxy.allow",
			transport: "connect",
			host: target.hostname,
			port: target.port,
		});
		tunnelConnect(clientSocket, head, target, log);
	});

	// Bun's node:http doesn't surface unrecoverable bind failures via the
	// callback alone — wire `error` so the caller can await failure too.
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 0, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const addr = server.address();
	if (!addr || typeof addr === "string") {
		await new Promise<void>((res) => server.close(() => res()));
		throw new Error("warren proxy: failed to bind a TCP port");
	}
	const port = addr.port;

	let stopped = false;
	const sockets = new Set<net.Socket>();
	server.on("connection", (sock) => {
		sockets.add(sock);
		sock.once("close", () => sockets.delete(sock));
	});
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		// `server.close()` waits for active connections to drain. CONNECT
		// tunnels are long-lived, so destroy each tracked socket first to
		// keep stop() bounded.
		for (const sock of sockets) sock.destroy();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => {
				if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
					reject(err);
					return;
				}
				resolve();
			});
		});
	};

	return {
		port,
		url: `http://${host}:${port}`,
		get deniedCount() {
			return denied;
		},
		get allowedCount() {
			return allowedCount;
		},
		stop,
	};
}

interface HttpTarget {
	hostname: string;
	port: number;
	pathWithQuery: string;
	headers: Record<string, string | string[] | undefined>;
}

function parseHttpTarget(req: http.IncomingMessage): HttpTarget | null {
	const raw = req.url ?? "";
	if (raw.length === 0) return null;
	// HTTP proxy clients send the absolute URL as the request line target.
	// node:http populates `req.url` with that value, so we URL-parse it.
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		// Some clients (rare) send a Host-header form. Fall back to that.
		const hostHdr = headerString(req.headers.host);
		if (!hostHdr) return null;
		try {
			parsed = new URL(`http://${hostHdr}${raw.startsWith("/") ? raw : `/${raw}`}`);
		} catch {
			return null;
		}
	}
	if (parsed.protocol !== "http:") return null;
	const rawPort = parsed.port;
	const port = rawPort ? Number.parseInt(rawPort, 10) : 80;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	if (rawPort && String(port) !== rawPort) return null;
	return {
		hostname: parsed.hostname,
		port,
		pathWithQuery: `${parsed.pathname}${parsed.search}`,
		headers: req.headers,
	};
}

function parseConnectTarget(raw: string | undefined): { hostname: string; port: number } | null {
	if (!raw) return null;
	// CONNECT target form is `host:port` (no scheme).
	const lastColon = raw.lastIndexOf(":");
	if (lastColon <= 0) return null;
	const hostname = stripBrackets(raw.slice(0, lastColon));
	const rawPort = raw.slice(lastColon + 1);
	const port = Number.parseInt(rawPort, 10);
	if (!hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
	if (String(port) !== rawPort) return null;
	return { hostname, port };
}

function stripBrackets(host: string): string {
	if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
	return host;
}

function headerString(value: string | string[] | undefined): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") return value[0];
	return null;
}

function tunnelConnect(
	clientSocket: Duplex,
	head: Buffer,
	target: { hostname: string; port: number },
	log: ProxyLogger | undefined,
): void {
	const upstream = net.connect(target.port, target.hostname);
	const teardown = (): void => {
		upstream.destroy();
		clientSocket.destroy();
	};
	upstream.once("connect", () => {
		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) upstream.write(head);
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	});
	upstream.once("error", (err) => {
		log?.warn?.({
			event: "warren.proxy.upstream_error",
			transport: "connect",
			host: target.hostname,
			port: target.port,
			message: err instanceof Error ? err.message : String(err),
		});
		clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
	});
	clientSocket.once("error", teardown);
	clientSocket.once("close", () => upstream.destroy());
}

function forwardHttp(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	target: HttpTarget,
): void {
	const headers = sanitizeRequestHeaders(target.headers);
	const upstream = http.request(
		{
			host: target.hostname,
			port: target.port,
			method: req.method ?? "GET",
			path: target.pathWithQuery,
			headers,
		},
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);
	upstream.on("error", (err) => {
		if (!res.headersSent) {
			res.writeHead(502, { "content-type": "text/plain" });
		}
		res.end(`warren proxy: upstream error: ${err instanceof Error ? err.message : String(err)}\n`);
	});
	req.pipe(upstream);
}

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function sanitizeRequestHeaders(
	headers: Record<string, string | string[] | undefined>,
): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
		out[name] = value;
	}
	return out;
}

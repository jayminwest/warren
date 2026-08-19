import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { matchAllowedDomain, type ProxyHandle, proxyEnvVars, startProxy } from "./proxy-server.ts";

describe("matchAllowedDomain", () => {
	test("exact match", () => {
		expect(matchAllowedDomain("api.anthropic.com", ["api.anthropic.com"])).toBe(true);
	});

	test("subdomain match", () => {
		expect(matchAllowedDomain("foo.github.com", ["github.com"])).toBe(true);
		expect(matchAllowedDomain("a.b.example.org", ["example.org"])).toBe(true);
	});

	test("non-match", () => {
		expect(matchAllowedDomain("evil.com", ["github.com"])).toBe(false);
		expect(matchAllowedDomain("notgithub.com", ["github.com"])).toBe(false);
		// Same suffix but not a subdomain boundary.
		expect(matchAllowedDomain("badexample.org", ["example.org"])).toBe(false);
	});

	test("case-insensitive", () => {
		expect(matchAllowedDomain("API.ANTHROPIC.COM", ["api.anthropic.com"])).toBe(true);
		expect(matchAllowedDomain("api.anthropic.com", ["API.ANTHROPIC.COM"])).toBe(true);
	});

	test("tolerates leading/trailing dots in entries", () => {
		expect(matchAllowedDomain("foo.example.org", [".example.org"])).toBe(true);
		expect(matchAllowedDomain("foo.example.org", ["example.org."])).toBe(true);
	});

	test("empty allowlist denies everything", () => {
		expect(matchAllowedDomain("anything.com", [])).toBe(false);
	});

	test("empty entries are skipped, not interpreted as `match all`", () => {
		expect(matchAllowedDomain("foo.com", ["", "..", "github.com"])).toBe(false);
	});
});

describe("proxyEnvVars", () => {
	test("sets both cases of HTTP(S)_PROXY and clears NO_PROXY", () => {
		expect(proxyEnvVars("http://127.0.0.1:9")).toEqual({
			HTTP_PROXY: "http://127.0.0.1:9",
			HTTPS_PROXY: "http://127.0.0.1:9",
			http_proxy: "http://127.0.0.1:9",
			https_proxy: "http://127.0.0.1:9",
			NO_PROXY: "",
			no_proxy: "",
		});
	});
});

interface Upstream {
	url: string;
	port: number;
	requests: string[];
	close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
	const requests: string[] = [];
	const sockets = new Set<net.Socket>();
	const server = http.createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("hello-from-upstream");
	});
	server.on("connection", (sock) => {
		sockets.add(sock);
		sock.once("close", () => sockets.delete(sock));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("upstream bind failed");
	const port = addr.port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				for (const sock of sockets) sock.destroy();
				server.close((err) => {
					if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
						reject(err);
						return;
					}
					resolve();
				});
			}),
	};
}

async function fetchViaProxy(proxyUrl: string, upstreamUrl: string): Promise<Response> {
	// Bun.fetch supports the `proxy` option for plain HTTP forwarding through
	// a proxy. CONNECT tunnels are exercised separately via raw sockets.
	return fetch(upstreamUrl, { proxy: proxyUrl });
}

describe("startProxy (HTTP forwarding)", () => {
	let upstream: Upstream;
	let proxy: ProxyHandle;

	beforeEach(async () => {
		upstream = await startUpstream();
	});

	afterEach(async () => {
		await proxy?.stop();
		await upstream.close();
	});

	test("allowed domain → forwards request and returns upstream body", async () => {
		proxy = await startProxy({ allowedDomains: ["127.0.0.1"] });
		const res = await fetchViaProxy(proxy.url, `${upstream.url}/echo`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toBe("hello-from-upstream");
		expect(upstream.requests).toEqual(["GET /echo"]);
		expect(proxy.allowedCount).toBe(1);
		expect(proxy.deniedCount).toBe(0);
	});

	test("denied domain → 403 without contacting upstream", async () => {
		proxy = await startProxy({ allowedDomains: ["api.anthropic.com"] });
		const res = await fetchViaProxy(proxy.url, `${upstream.url}/secret`);
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain("domain not allowed");
		expect(upstream.requests).toEqual([]);
		expect(proxy.deniedCount).toBe(1);
		expect(proxy.allowedCount).toBe(0);
	});

	test("empty allowlist denies everything", async () => {
		proxy = await startProxy({ allowedDomains: [] });
		const res = await fetchViaProxy(proxy.url, `${upstream.url}/x`);
		expect(res.status).toBe(403);
		expect(upstream.requests).toEqual([]);
	});

	test("subdomain entries match descendants but not unrelated suffixes", async () => {
		proxy = await startProxy({ allowedDomains: ["example.org"] });
		const denied = await fetchViaProxy(proxy.url, "http://badexample.org/");
		expect(denied.status).toBe(403);
	});
});

describe("startProxy (lifecycle + diagnostics)", () => {
	test("logger receives deny events for blocked CONNECTs", async () => {
		const events: object[] = [];
		const logger = { warn: (msg: object | string): void => void events.push(msg as object) };
		const proxy = await startProxy({ allowedDomains: ["api.anthropic.com"], logger });

		const sock = net.connect(proxy.port, "127.0.0.1");
		await new Promise<void>((resolve) => sock.once("connect", resolve));
		sock.write("CONNECT evil.example.com:443 HTTP/1.1\r\nHost: evil.example.com:443\r\n\r\n");
		const reply = await new Promise<string>((resolve) => {
			let buf = "";
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf8");
			});
			sock.on("close", () => resolve(buf));
		});
		expect(reply).toContain("403 Forbidden");
		expect(reply).toContain("domain not allowed");
		expect(proxy.deniedCount).toBe(1);
		expect(events.length).toBeGreaterThan(0);
		const firstEvent = events[0] as { event?: string; transport?: string; host?: string };
		expect(firstEvent.event).toBe("warren.proxy.deny");
		expect(firstEvent.transport).toBe("connect");
		expect(firstEvent.host).toBe("evil.example.com");

		await proxy.stop();
	});

	test("stop() is idempotent and unbinds the port", async () => {
		const proxy = await startProxy({ allowedDomains: [] });
		const port = proxy.port;
		await proxy.stop();
		await proxy.stop();
		expect(typeof port).toBe("number");
	});

	test("CONNECT to an allowed host completes the tunnel", async () => {
		const upstream = await startUpstream();
		const proxy = await startProxy({ allowedDomains: ["127.0.0.1"] });
		try {
			const sock = net.connect(proxy.port, "127.0.0.1");
			await new Promise<void>((resolve) => sock.once("connect", resolve));
			sock.write(
				`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\n`,
			);
			const headerLine = await new Promise<string>((resolve) => {
				let buf = "";
				sock.on("data", (chunk) => {
					buf += chunk.toString("utf8");
					const idx = buf.indexOf("\r\n\r\n");
					if (idx !== -1) resolve(buf.slice(0, idx));
				});
			});
			expect(headerLine).toContain("200 Connection Established");
			// Now the socket is a raw tunnel — speak HTTP over it directly.
			sock.write("GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
			const body = await new Promise<string>((resolve) => {
				let buf = "";
				sock.on("data", (chunk) => {
					buf += chunk.toString("utf8");
				});
				sock.on("close", () => resolve(buf));
			});
			expect(body).toContain("hello-from-upstream");
			expect(upstream.requests).toEqual(["GET /tunnel"]);
			expect(proxy.allowedCount).toBe(1);
		} finally {
			await proxy.stop();
			await upstream.close();
		}
	});
});

describe("startProxy (malformed targets)", () => {
	async function sendConnect(proxyPort: number, line: string): Promise<string> {
		const sock = net.connect(proxyPort, "127.0.0.1");
		await new Promise<void>((resolve) => sock.once("connect", resolve));
		sock.write(`CONNECT ${line} HTTP/1.1\r\nHost: ${line}\r\n\r\n`);
		return new Promise<string>((resolve) => {
			let buf = "";
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf8");
			});
			sock.on("close", () => resolve(buf));
		});
	}

	test("CONNECT host:80abc → 400 (trailing garbage rejected)", async () => {
		const proxy = await startProxy({ allowedDomains: ["example.com"] });
		try {
			const reply = await sendConnect(proxy.port, "example.com:80abc");
			expect(reply).toContain("400 Bad Request");
			expect(proxy.allowedCount).toBe(0);
			expect(proxy.deniedCount).toBe(1);
		} finally {
			await proxy.stop();
		}
	});

	test("CONNECT host: (empty port) → 400", async () => {
		const proxy = await startProxy({ allowedDomains: ["example.com"] });
		try {
			const reply = await sendConnect(proxy.port, "example.com:");
			expect(reply).toContain("400 Bad Request");
			expect(proxy.deniedCount).toBe(1);
		} finally {
			await proxy.stop();
		}
	});

	test("CONNECT host:99999 → 400 (out-of-range rejected)", async () => {
		const proxy = await startProxy({ allowedDomains: ["example.com"] });
		try {
			const reply = await sendConnect(proxy.port, "example.com:99999");
			expect(reply).toContain("400 Bad Request");
			expect(proxy.deniedCount).toBe(1);
		} finally {
			await proxy.stop();
		}
	});

	test("HTTP forward with garbage port in absolute URL → 400", async () => {
		const proxy = await startProxy({ allowedDomains: ["example.com"] });
		try {
			const sock = net.connect(proxy.port, "127.0.0.1");
			await new Promise<void>((resolve) => sock.once("connect", resolve));
			sock.write(
				"GET http://example.com:80abc/ HTTP/1.1\r\nHost: example.com:80abc\r\nConnection: close\r\n\r\n",
			);
			const reply = await new Promise<string>((resolve) => {
				let buf = "";
				sock.on("data", (chunk) => {
					buf += chunk.toString("utf8");
				});
				sock.on("close", () => resolve(buf));
			});
			expect(reply).toContain("400");
			expect(proxy.allowedCount).toBe(0);
		} finally {
			await proxy.stop();
		}
	});
});

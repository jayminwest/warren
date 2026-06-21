import { describe, expect, test } from "bun:test";
import { probeOnce, tcpConnectOnce } from "./probe.ts";

// Build a fetch stand-in that returns a Response with the given status, or
// throws to simulate a transport-level failure (refused/abort).
function fakeFetch(status: number | "throw"): typeof fetch {
	return (async () => {
		if (status === "throw") throw new Error("ECONNREFUSED");
		return new Response("body", { status });
	}) as unknown as typeof fetch;
}

describe("probeOnce (warren-9b15)", () => {
	test("returns 'ready' for a 2xx response", async () => {
		expect(await probeOnce(fakeFetch(200), "http://x", 100)).toBe("ready");
	});

	test("treats a 3xx redirect as 'ready'", async () => {
		expect(await probeOnce(fakeFetch(302), "http://x", 100)).toBe("ready");
	});

	test("returns 'http_response' for a non-2xx/3xx response", async () => {
		expect(await probeOnce(fakeFetch(503), "http://x", 100)).toBe("http_response");
	});

	test("returns 'not_connected' when fetch throws", async () => {
		expect(await probeOnce(fakeFetch("throw"), "http://x", 100)).toBe("not_connected");
	});
});

// warren-f04c / pl-592f step 3: direct unit tests for the phase-1 TCP-only
// probe helper. These exercise the real Bun.connect path (not an injected
// fake) on localhost, so a regression that breaks the helper itself —
// e.g. failing to close the socket, never resolving on refused, ignoring
// the timeout — surfaces here instead of leaking into integration tests.
describe("tcpConnectOnce (warren-49d9 / pl-592f step 1)", () => {
	test("returns 'connected' for a port that is listening, and closes the socket", async () => {
		// Bind a real TCP listener on an ephemeral port. We track inbound
		// sockets so we can assert the probe closes its side promptly.
		const openedSockets: Array<{ closed: boolean }> = [];
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(_sock) {
					const rec = { closed: false };
					openedSockets.push(rec);
				},
				close(_sock) {
					const rec = openedSockets[openedSockets.length - 1];
					if (rec !== undefined) rec.closed = true;
				},
				data() {},
				error() {},
			},
		});
		try {
			const port = server.port;
			const outcome = await tcpConnectOnce("127.0.0.1", port, 1_000);
			expect(outcome).toBe("connected");
			// Give the kernel a tick to deliver the close.
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			expect(openedSockets.length).toBeGreaterThanOrEqual(1);
			// At least one socket from the probe should be closed.
			expect(openedSockets.some((s) => s.closed)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test("returns 'not_connected' when the port is refused (no listener)", async () => {
		// Bind then immediately stop so the port is almost certainly free
		// and refused. (Using a fixed high port risks collisions in CI.)
		const tmp = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { open() {}, close() {}, data() {}, error() {} },
		});
		const port = tmp.port;
		tmp.stop(true);
		// Tiny wait so the kernel finishes tearing down the listener.
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		const outcome = await tcpConnectOnce("127.0.0.1", port, 1_000);
		expect(outcome).toBe("not_connected");
	});

	test("returns 'not_connected' when the connect handshake exceeds timeoutMs", async () => {
		// 192.0.2.1 is RFC 5737 TEST-NET-1 — reserved for documentation and
		// reliably unrouted on real networks, so SYNs are dropped and the
		// timer fires. If the local stack rejects it synchronously (e.g.
		// EHOSTUNREACH on locked-down sandboxes) we still get 'not_connected'
		// via the error arm — same outcome, same assertion.
		const start = Date.now();
		const outcome = await tcpConnectOnce("192.0.2.1", 1, 100);
		const elapsed = Date.now() - start;
		expect(outcome).toBe("not_connected");
		// Must respect the timeoutMs bound (with generous slack for CI).
		expect(elapsed).toBeLessThan(2_000);
	});
});

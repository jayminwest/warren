/**
 * End-to-end checks that the X-Request-ID middleware (warren-30af /
 * pl-7b06 step 19) is wired correctly into `startServer`: every
 * outgoing response carries the header, regardless of which dispatch
 * branch produced it (success, auth deny, JSON 404).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../runs/index.ts";
import { FakeProvider } from "../runtime/fake/fake-provider.ts";
import { bearerAuth, NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { Route, ServeHandle, ServerDeps } from "./types.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

// Capture a single log level into `events` while staying silent elsewhere.
function captureLogger(level: "info" | "warn" | "error") {
	const events: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
	const logger = {
		...silentLogger,
		[level]: (obj: object, msg?: string) =>
			events.push({ obj: obj as Record<string, unknown>, msg }),
	};
	return { events, logger };
}

async function depsFor(repos: Repos): Promise<ServerDeps> {
	const sandboxClient = new FakeProvider();
	const broker = new RunEventBroker();
	return {
		repos,
		runtimeProvider: sandboxClient,
		forge: new FakeForge(),
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			runtimeProvider: sandboxClient,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("X-Request-ID wire integration (warren-30af)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("stamps a freshly minted uuid on responses without an inbound header", async () => {
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/healthz`);
		const id = res.headers.get("x-request-id");
		expect(id).not.toBeNull();
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("honours a well-formed inbound X-Request-ID and echoes it", async () => {
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/healthz`, {
			headers: { "x-request-id": "trace-abc-123" },
		});
		expect(res.headers.get("x-request-id")).toBe("trace-abc-123");
	});

	test("rejects a hostile inbound value and mints a fresh id", async () => {
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/healthz`, {
			headers: { "x-request-id": "contains spaces" },
		});
		const id = res.headers.get("x-request-id");
		expect(id).not.toBe("contains spaces");
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("stamps the id on 401 auth-denied responses", async () => {
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("secret"),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/projects`, {
			headers: { "x-request-id": "deny-trace" },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("x-request-id")).toBe("deny-trace");
	});

	test("emits one access log line per request (warren-26c2)", async () => {
		const { events, logger } = captureLogger("info");
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger,
		});
		await fetch(`${tcpUrl(handle)}/projects`);
		const obj = events.find((e) => e.msg === "server.request")?.obj;
		expect(obj).toMatchObject({ method: "GET", path: "/projects", status: 200 });
		expect(typeof obj?.duration_ms).toBe("number");
	});

	test("warns on every auth denial (warren-26c2)", async () => {
		const { events, logger } = captureLogger("warn");
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("secret"),
			logger,
		});
		const res = await fetch(`${tcpUrl(handle)}/projects`);
		expect(res.status).toBe(401);
		const obj = events.find((e) => e.msg === "server.auth_denied")?.obj;
		expect(obj).toMatchObject({ path: "/projects", status: 401 });
	});

	test("an untyped handler throw leaks nothing and quotes the correlation id (warren-4385)", async () => {
		const leaky = `sd show failed: ENOENT ${process.cwd()}/data/warren/projects/acme/.seeds`;
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/boom",
				policy: "readPublic",
				handler: () => {
					throw new Error(leaky);
				},
			},
		];
		const { events, logger } = captureLogger("error");
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger,
			routes,
		});
		const res = await fetch(`${tcpUrl(handle)}/boom`, {
			headers: { "x-request-id": "boom-trace" },
		});
		expect(res.status).toBe(500);
		const text = await res.text();
		// Body: generic message + correlation id, and none of the thrown detail.
		expect(JSON.parse(text)).toEqual({
			error: {
				code: "internal_error",
				message: "internal server error",
				hint: "check the warren server logs for request id boom-trace",
			},
		});
		expect(text).not.toContain(process.cwd());
		expect(text).not.toContain("/data/warren");
		expect(text).not.toContain("ENOENT");
		expect(res.headers.get("x-request-id")).toBe("boom-trace");
		// Log: the full message and stack, findable by the same id (request_id is
		// bound onto the per-request child logger).
		const obj = events.find((e) => e.msg === "server: handler threw")?.obj;
		expect(obj?.err_message).toBe(leaky);
		expect(String(obj?.err_stack)).toContain(leaky);
		expect(obj?.request_id).toBe("boom-trace");
	});

	test("stamps the id on api 404 responses", async () => {
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/projects/does-not-exist-zzz/nope`, {
			headers: { "x-request-id": "nf-trace" },
		});
		expect(res.status).toBe(404);
		expect(res.headers.get("x-request-id")).toBe("nf-trace");
	});
});

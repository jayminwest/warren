/**
 * End-to-end checks that the X-Request-ID middleware (warren-30af /
 * pl-7b06 step 19) is wired correctly into `startServer`: every
 * outgoing response carries the header, regardless of which dispatch
 * branch produced it (success, auth deny, JSON 404).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { bearerAuth, NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { ServeHandle, ServerDeps } from "./types.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

function stubFetch(): typeof fetch {
	return (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as never;
}

async function depsFor(repos: Repos): Promise<ServerDeps> {
	const burrowClient = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stubFetch(),
	});
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const burrowClientPool = new BurrowClientPool({ repos });
	burrowClientPool.register("local", burrowClient);
	const broker = new RunEventBroker();
	return {
		repos,
		burrowClientPool,
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			burrowClientPool,
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

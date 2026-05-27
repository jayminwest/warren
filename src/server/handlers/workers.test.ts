import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";

const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
};

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface AdminCall {
	method: string;
	path: string;
	body: unknown;
	auth: string | null;
}

function makeAdminClient(opts: {
	calls: AdminCall[];
	respond?: (drain: boolean) => Response;
}): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" }, token: "secret" },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			opts.calls.push({
				method,
				path,
				body: reqBody,
				auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
			});
			if (method === "POST" && path === "/admin/drain") {
				const drain = (reqBody as { drain: boolean }).drain;
				return opts.respond?.(drain) ?? jsonResponse(200, { drain });
			}
			return jsonResponse(404, {
				error: { code: "not_found", message: `unmatched ${method} ${path}` },
			});
		}),
	});
}

async function poolWith(
	repos: Repos,
	workers: readonly {
		name: string;
		client: BurrowClient;
		state?: "healthy" | "draining" | "unreachable";
	}[],
): Promise<BurrowClientPool> {
	const pool = new BurrowClientPool({ repos });
	for (const w of workers) {
		await repos.workers.upsert({
			name: w.name,
			url: `unix:///tmp/${w.name}.sock`,
			...(w.state !== undefined ? { state: w.state } : {}),
		});
		pool.register(w.name, w.client);
	}
	return pool;
}

function depsFor(repos: Repos, pool: BurrowClientPool): ServerDeps {
	const broker = new RunEventBroker();
	return {
		repos,
		burrowClientPool: pool,
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			burrowClientPool: pool,
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

describe("GET /workers", () => {
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

	test("returns the full workers table with registration flag", async () => {
		const calls: AdminCall[] = [];
		const alpha = makeAdminClient({ calls });
		const beta = makeAdminClient({ calls });
		const pool = await poolWith(repos, [
			{ name: "alpha", client: alpha },
			{ name: "beta", client: beta, state: "draining" },
		]);
		// Add a row that's in the workers table but not in the pool — simulates
		// drift between `[workers]` config and pool registration so the
		// operator-facing list shows registered=false.
		await repos.workers.upsert({ name: "ghost", url: "unix:///tmp/ghost.sock" });

		handle = startServer(depsFor(repos, pool), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/workers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			workers: { name: string; state: string; registered: boolean }[];
		};
		expect(
			body.workers.map((w) => ({ name: w.name, state: w.state, registered: w.registered })),
		).toEqual([
			{ name: "alpha", state: "healthy", registered: true },
			{ name: "beta", state: "draining", registered: true },
			{ name: "ghost", state: "healthy", registered: false },
		]);
	});

	test("returns an empty array when no workers are registered", async () => {
		const pool = new BurrowClientPool({ repos });
		handle = startServer(depsFor(repos, pool), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/workers`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ workers: [] });
	});
});

describe("POST /workers/:name/drain", () => {
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

	test("default body drains the worker: forwards /admin/drain and flips state to draining", async () => {
		const calls: AdminCall[] = [];
		const alpha = makeAdminClient({ calls });
		const pool = await poolWith(repos, [{ name: "alpha", client: alpha }]);
		handle = startServer(depsFor(repos, pool), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/workers/alpha/drain`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "alpha", state: "draining", drain: true });
		expect((await repos.workers.require("alpha")).state).toBe("draining");
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("expected one admin call");
		expect(call.method).toBe("POST");
		expect(call.path).toBe("/admin/drain");
		expect(call.body).toEqual({ drain: true });
		expect(call.auth).toBe("Bearer secret");
	});

	test("`{drain: false}` un-drains: forwards drain=false and flips state to healthy", async () => {
		const calls: AdminCall[] = [];
		const alpha = makeAdminClient({ calls });
		const pool = await poolWith(repos, [{ name: "alpha", client: alpha, state: "draining" }]);
		handle = startServer(depsFor(repos, pool), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/workers/alpha/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ drain: false }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "alpha", state: "healthy", drain: false });
		expect((await repos.workers.require("alpha")).state).toBe("healthy");
		expect(calls[0]?.body).toEqual({ drain: false });
	});

	test("404 when warren has no row for the named worker", async () => {
		const calls: AdminCall[] = [];
		const alpha = makeAdminClient({ calls });
		const pool = await poolWith(repos, [{ name: "alpha", client: alpha }]);
		handle = startServer(depsFor(repos, pool), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/workers/ghost/drain`, { method: "POST" });
		expect(res.status).toBe(404);
		expect(calls).toHaveLength(0);
	});

	test("burrow-side failure leaves warren state untouched", async () => {
		const calls: AdminCall[] = [];
		const alpha = makeAdminClient({
			calls,
			respond: () =>
				jsonResponse(404, {
					error: { code: "not_found", message: "no route matches /admin/drain" },
				}),
		});
		const pool = await poolWith(repos, [{ name: "alpha", client: alpha }]);
		handle = startServer(depsFor(repos, pool), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/workers/alpha/drain`, { method: "POST" });
		expect(res.status).toBe(404);
		expect((await repos.workers.require("alpha")).state).toBe("healthy");
	});

	test("400 when `drain` body field is not a boolean", async () => {
		const calls: AdminCall[] = [];
		const alpha = makeAdminClient({ calls });
		const pool = await poolWith(repos, [{ name: "alpha", client: alpha }]);
		handle = startServer(depsFor(repos, pool), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/workers/alpha/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ drain: "yes" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});

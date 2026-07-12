import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
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

/**
 * warren-76c5: multi-worker pooling is retired — the self-host backend is a
 * single local burrow. Tests upsert `workers` rows directly (the table lives
 * until step 24) and the handler forwards drain to the one injected client.
 */
async function upsertWorkers(
	repos: Repos,
	workers: readonly {
		name: string;
		state?: "healthy" | "draining" | "unreachable";
	}[],
): Promise<void> {
	for (const w of workers) {
		await repos.workers.upsert({
			name: w.name,
			url: `unix:///tmp/${w.name}.sock`,
			...(w.state !== undefined ? { state: w.state } : {}),
		});
	}
}

function stubClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async () => jsonResponse(404, { error: { code: "not_found", message: "stub" } })),
	});
}

function depsFor(repos: Repos, pool: BurrowClient): ServerDeps {
	const broker = new RunEventBroker();
	return {
		repos,
		burrowClient: pool,
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			burrowClient: pool,
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

	test("marks only the local worker registered; surviving rows report registered=false", async () => {
		await upsertWorkers(repos, [
			{ name: "local" },
			{ name: "beta", state: "draining" },
			{ name: "ghost" },
		]);

		handle = startServer(depsFor(repos, stubClient()), {
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
			{ name: "beta", state: "draining", registered: false },
			{ name: "ghost", state: "healthy", registered: false },
			{ name: "local", state: "healthy", registered: true },
		]);
	});

	test("returns an empty array when no workers are registered", async () => {
		handle = startServer(depsFor(repos, stubClient()), {
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
		await upsertWorkers(repos, [{ name: "alpha" }]);
		handle = startServer(depsFor(repos, alpha), {
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
		await upsertWorkers(repos, [{ name: "alpha", state: "draining" }]);
		handle = startServer(depsFor(repos, alpha), {
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
		await upsertWorkers(repos, [{ name: "alpha" }]);
		handle = startServer(depsFor(repos, alpha), {
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
		await upsertWorkers(repos, [{ name: "alpha" }]);
		handle = startServer(depsFor(repos, alpha), {
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
		await upsertWorkers(repos, [{ name: "alpha" }]);
		handle = startServer(depsFor(repos, alpha), {
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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, Logger, ServeHandle, ServerDeps } from "../types.ts";

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

interface BurrowFixture {
	id: string;
	createdAt: string;
	kind?: string;
	state?: string;
	projectRoot?: string;
}

function makeWorkerClient(opts: {
	rows: readonly BurrowFixture[];
	failList?: boolean;
	getById?: ReadonlyMap<string, BurrowFixture>;
	calls?: { method: string; path: string; query?: string }[];
}): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			opts.calls?.push({ method, path, query: url.search });

			if (method === "GET" && path === "/burrows") {
				if (opts.failList === true) {
					const err = new TypeError("fetch failed");
					(err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
					throw err;
				}
				// Echo the requested filter back through a simple in-memory filter so
				// the test can assert the query parameters were forwarded.
				const kind = url.searchParams.get("kind");
				const state = url.searchParams.get("state");
				const projectRoot = url.searchParams.get("projectRoot");
				const filtered = opts.rows.filter((r) => {
					if (kind !== null && r.kind !== kind) return false;
					if (state !== null && r.state !== state) return false;
					if (projectRoot !== null && r.projectRoot !== projectRoot) return false;
					return true;
				});
				return jsonResponse(
					200,
					filtered.map((r) => burrowWire(r)),
				);
			}

			const getMatch = /^\/burrows\/([^/]+)$/.exec(path);
			if (method === "GET" && getMatch) {
				const id = decodeURIComponent(getMatch[1] ?? "");
				const row = opts.getById?.get(id);
				if (row === undefined) {
					return jsonResponse(404, {
						error: { code: "not_found", message: `burrow ${id} not found` },
					});
				}
				return jsonResponse(200, burrowWire(row));
			}

			return jsonResponse(404, {
				error: { code: "not_found", message: `unmatched ${method} ${path}` },
			});
		}),
	});
}

function burrowWire(r: BurrowFixture): Record<string, unknown> {
	return {
		id: r.id,
		name: r.id,
		kind: r.kind ?? "task",
		projectRoot: r.projectRoot ?? "/data/projects/x/y",
		branch: "main",
		baseBranch: "main",
		originUrl: "https://github.com/x/y.git",
		workspacePath: `/tmp/${r.id}`,
		provider: "local",
		sandbox: { network: "open" },
		state: r.state ?? "active",
		createdAt: r.createdAt,
		updatedAt: r.createdAt,
	};
}

/**
 * warren-76c5: multi-worker fan-out is retired — the self-host backend is a
 * single local burrow. Tests inject one client; the handlers list / fetch
 * against it directly. The `workers`/`burrows` tables live until step 24.
 */
async function localClient(repos: Repos, client: BurrowClient): Promise<BurrowClient> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/local.sock" });
	return client;
}

function depsFor(
	repos: Repos,
	client: BurrowClient,
	logger: Logger = silentLogger,
	bridges?: BridgeRegistry,
): ServerDeps {
	const broker = new RunEventBroker();
	return {
		repos,
		burrowClient: client,
		broker,
		bridges:
			bridges ??
			createBridgeRegistry({
				repos,
				broker,
				burrowClient: client,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger,
		uiDistDir: null,
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("GET /burrows — single local burrow (warren-76c5)", () => {
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

	test("lists the local burrow's burrows sorted by createdAt ascending", async () => {
		const client = makeWorkerClient({
			rows: [
				{ id: "bur_a1", createdAt: "2026-05-10T01:00:00Z" },
				{ id: "bur_b1", createdAt: "2026-05-10T00:30:00Z" },
				{ id: "bur_b2", createdAt: "2026-05-10T02:00:00Z" },
			],
		});
		handle = startServer(depsFor(repos, await localClient(repos, client)), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/burrows`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			burrows: { id: string }[];
			workerErrors: { worker: string; message: string }[];
		};
		expect(body.burrows.map((b) => b.id)).toEqual(["bur_b1", "bur_a1", "bur_b2"]);
		expect(body.workerErrors).toEqual([]);
	});

	test("returns empty burrows + a workerErrors envelope when the burrow is unreachable", async () => {
		const client = makeWorkerClient({ rows: [], failList: true });
		const warnings: { obj: object; msg: string | undefined }[] = [];
		const logger: Logger = {
			info() {},
			warn(obj: object, msg?: string) {
				warnings.push({ obj, msg });
			},
			error() {},
		};

		handle = startServer(depsFor(repos, await localClient(repos, client), logger), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/burrows`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			burrows: { id: string }[];
			workerErrors: { worker: string; message: string }[];
		};
		expect(body.burrows).toEqual([]);
		expect(body.workerErrors).toHaveLength(1);
		expect(body.workerErrors[0]?.worker).toBe("local");

		const warn = warnings.find((w) => w.msg === "worker_unreachable");
		expect(warn?.obj).toMatchObject({ op: "burrows.list" });
	});

	test("forwards kind / state / projectRoot filters to the local burrow", async () => {
		const calls: { method: string; path: string; query?: string }[] = [];
		const client = makeWorkerClient({
			rows: [{ id: "bur_a1", createdAt: "2026-05-10T01:00:00Z", kind: "task", state: "active" }],
			calls,
		});
		handle = startServer(depsFor(repos, await localClient(repos, client)), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/burrows?kind=task&state=active&projectRoot=/x/y`);
		expect(res.status).toBe(200);
		expect(calls[0]?.query).toBe("?kind=task&state=active&projectRoot=%2Fx%2Fy");
	});

	test("rejects an unknown ?kind value with 400 validation_error", async () => {
		const client = makeWorkerClient({ rows: [] });
		handle = startServer(depsFor(repos, await localClient(repos, client)), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/burrows?kind=bogus`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("returns empty arrays when the local burrow has none", async () => {
		const client = makeWorkerClient({ rows: [] });
		handle = startServer(depsFor(repos, await localClient(repos, client)), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/burrows`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			burrows: unknown[];
			workerErrors: unknown[];
		};
		expect(body.burrows).toEqual([]);
		expect(body.workerErrors).toEqual([]);
	});
});

describe("GET /burrows/:id — single local burrow (warren-76c5)", () => {
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

	test("forwards GET to the local burrow when warren has a burrows row", async () => {
		const calls: { method: string; path: string; query?: string }[] = [];
		const fix: BurrowFixture = { id: "bur_b1", createdAt: "2026-05-10T02:00:00Z" };
		const client = makeWorkerClient({
			rows: [fix],
			getById: new Map([[fix.id, fix]]),
			calls,
		});
		await repos.burrows.create({ id: fix.id, workerId: "local" });

		handle = startServer(depsFor(repos, await localClient(repos, client)), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/burrows/${fix.id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string };
		expect(body.id).toBe(fix.id);
		expect(calls.some((c) => c.method === "GET" && c.path === `/burrows/${fix.id}`)).toBe(true);
	});

	test("404 when warren has no burrows row for the id", async () => {
		const client = makeWorkerClient({ rows: [] });
		handle = startServer(depsFor(repos, await localClient(repos, client)), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/burrows/bur_unknown`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});
});

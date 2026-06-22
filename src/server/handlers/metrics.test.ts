import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { MetricsRegistry } from "../../observability/metrics-registry.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { bearerAuth } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";

const TOKEN = "metrics-test-token-0000000000000000000000";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch,
	});
}

async function depsFor(
	repos: Repos,
	db: WarrenDb,
	registry?: MetricsRegistry,
): Promise<ServerDeps> {
	const client = makeBurrowClient();
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const burrowClientPool = new BurrowClientPool({ repos });
	burrowClientPool.register("local", client);
	const broker = new RunEventBroker();
	const bridges = createBridgeRegistry({
		repos,
		broker,
		burrowClientPool,
		bridge: async () => ({ written: 0, skipped: 0, errored: false }),
	});
	return {
		repos,
		db,
		burrowClientPool,
		broker,
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(registry !== undefined ? { metricsRegistry: registry } : {}),
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("GET /metrics", () => {
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

	test("is auth-exempt and exposes run/bridge gauges + registry counters", async () => {
		const registry = new MetricsRegistry();
		registry.increment("warren_log_messages_total", { level: "warn" });
		registry.increment("warren_log_messages_total", { level: "error" });
		const deps = await depsFor(repos, db, registry);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		// No Authorization header — must still return 200.
		const res = await fetch(`${tcpUrl(handle)}/metrics`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
		const body = await res.text();
		expect(body).toContain("# TYPE warren_runs gauge");
		expect(body).toContain("warren_active_bridges 0");
		expect(body).toContain("warren_cost_usd 0");
		expect(body).toContain("warren_tokens_input 0");
		expect(body).toContain("warren_tokens_output 0");
		// Genuine counter keeps its _total suffix.
		expect(body).toContain('warren_log_messages_total{level="warn"} 1');
		expect(body).toContain('warren_log_messages_total{level="error"} 1');
	});

	test("rejects non-GET with a 405 JSON envelope", async () => {
		const deps = await depsFor(repos, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/metrics`, { method: "POST" });
		expect(res.status).toBe(405);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { MetricsRegistry } from "../../observability/metrics-registry.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { createDbSeams } from "../db-seams.ts";
import { startServer } from "../server.ts";
import { EventStreamLimiter } from "../stream-limits.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";

const TOKEN = "metrics-test-token-0000000000000000000000";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeSandboxClient(): FakeProvider {
	return new FakeProvider();
}

async function depsFor(
	repos: Repos,
	db: WarrenDb,
	registry?: MetricsRegistry,
	streamLimiter?: EventStreamLimiter,
): Promise<ServerDeps> {
	const sandboxClient = makeSandboxClient();
	const broker = new RunEventBroker();
	const bridges = createBridgeRegistry({
		repos,
		broker,
		runtimeProvider: sandboxClient,
		bridge: async () => ({ written: 0, skipped: 0, errored: false }),
	});
	return {
		repos,
		db,
		...createDbSeams(db),
		runtimeProvider: sandboxClient,
		forge: new FakeForge(),
		broker,
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(registry !== undefined ? { metricsRegistry: registry } : {}),
		...(streamLimiter !== undefined ? { streamLimiter } : {}),
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

	test("is bearer-gated (warren-682a) and exposes run/bridge gauges + registry counters", async () => {
		const registry = new MetricsRegistry();
		registry.increment("warren_log_messages_total", { level: "warn" });
		registry.increment("warren_log_messages_total", { level: "error" });
		const deps = await depsFor(repos, db, registry);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		// No Authorization header — the scrape surface is gated.
		const unauthed = await fetch(`${tcpUrl(handle)}/metrics`);
		expect(unauthed.status).toBe(401);
		const res = await fetch(`${tcpUrl(handle)}/metrics`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
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

	test("reports event-stream saturation when a stream limiter is wired (warren-25f6)", async () => {
		const limiter = new EventStreamLimiter({
			maxGlobal: 8,
			maxPerClient: 2,
			maxLifetimeMs: 0,
			trustedProxyHops: 0,
		});
		limiter.acquire("1.2.3.4");
		limiter.acquire("5.6.7.8");
		handle = startServer(await depsFor(repos, db, undefined, limiter), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const body = await fetch(`${tcpUrl(handle)}/metrics`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		}).then((r) => r.text());
		expect(body).toContain("# TYPE warren_event_streams gauge");
		expect(body).toContain("warren_event_streams 2");
	});

	test("omits the event-stream gauge when no limiter is wired", async () => {
		handle = startServer(await depsFor(repos, db), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const body = await fetch(`${tcpUrl(handle)}/metrics`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		}).then((r) => r.text());
		expect(body).not.toContain("warren_event_streams");
	});

	test("appends K8s pod-phase gauges when a pod-metrics source is wired", async () => {
		const deps: ServerDeps = {
			...(await depsFor(repos, db)),
			podMetrics: {
				metricsSnapshot: () => ({
					phaseCounts: { Pending: 2, Running: 3 },
					pendingDurationSeconds: 17,
					lastInitDurationSeconds: 4.5,
				}),
			},
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/metrics`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		const body = await res.text();
		expect(body).toContain("# TYPE warren_run_pod_phase gauge");
		expect(body).toContain('warren_run_pod_phase{phase="Pending"} 2');
		expect(body).toContain('warren_run_pod_phase{phase="Running"} 3');
		expect(body).toContain("warren_pod_pending_duration_seconds 17");
		expect(body).toContain("warren_workspace_init_duration_seconds 4.5");
	});

	test("omits pod-phase gauges when no pod-metrics source is wired (LocalProvider)", async () => {
		const deps = await depsFor(repos, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/metrics`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		const body = await res.text();
		expect(body).not.toContain("warren_run_pod_phase");
	});

	test("rejects non-GET with a 405 JSON envelope", async () => {
		const deps = await depsFor(repos, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/metrics`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(405);
	});
});

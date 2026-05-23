import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { SpawnFn } from "../projects/clone.ts";
import { RunEventBroker } from "../runs/index.ts";
import { bearerAuth, NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { BridgeRegistry, Route, ServeHandle, ServeOptions, ServerDeps } from "./types.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
	});
}

/**
 * Default spawn stub: succeeds for `bwrap --version` and `git status
 * --porcelain` so readyz/doctor probes don't shell out to the host
 * during tests. Individual tests can pass their own override.
 */
const okSpawn: SpawnFn = async (cmd) => {
	if (cmd[0]?.endsWith("bwrap")) {
		return { stdout: "bubblewrap 0.8.0\n", stderr: "", exitCode: 0 };
	}
	if (cmd.includes("status") && cmd.includes("--porcelain")) {
		return { stdout: "", stderr: "", exitCode: 0 };
	}
	return { stdout: "", stderr: "", exitCode: 0 };
};

async function depsFor(
	repos: Repos,
	bridges?: BridgeRegistry,
	overrides: {
		spawn?: SpawnFn;
		canopyDir?: string;
		uiDistDir?: string | null;
		db?: WarrenDb;
	} = {},
): Promise<ServerDeps> {
	const burrowClient = makeBurrowClient();
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const burrowClientPool = new BurrowClientPool({ repos });
	burrowClientPool.register("local", burrowClient);
	const broker = new RunEventBroker();
	return {
		repos,
		...(overrides.db !== undefined ? { db: overrides.db } : {}),
		burrowClientPool,
		broker,
		bridges:
			bridges ??
			createBridgeRegistry({
				repos,
				broker,
				burrowClientPool,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		canopyConfig: {
			repoUrl: "https://example/agents.git",
			localDir: overrides.canopyDir ?? "/tmp/warren-canopy-nonexistent",
			cnBinary: "cn",
			gitBinary: "git",
		},
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: overrides.uiDistDir === undefined ? null : overrides.uiDistDir,
		spawn: overrides.spawn ?? okSpawn,
	};
}

function setupUiDist(): string {
	const dir = mkdtempSync(join(tmpdir(), "warren-server-ui-"));
	writeFileSync(join(dir, "index.html"), "<html><body>warren ui</body></html>");
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(join(dir, "assets", "app.js"), "console.log('hi')");
	return dir;
}

function tcpOpts(extra: Partial<ServeOptions> = {}): ServeOptions {
	return {
		transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		auth: NO_AUTH,
		logger: silentLogger,
		...extra,
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("startServer — lifecycle", () => {
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

	test("binds an ephemeral port and exposes the resolved url", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		expect(handle.transport.kind).toBe("tcp");
		if (handle.transport.kind === "tcp") {
			expect(handle.transport.port).toBeGreaterThan(0);
		}
	});

	test("/healthz is auth-exempt and returns 200 ok", async () => {
		handle = startServer(await depsFor(repos), tcpOpts({ auth: bearerAuth("secret") }));
		const res = await fetch(`${tcpUrl(handle)}/healthz`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
	});

	test("auth required for non-healthz routes", async () => {
		handle = startServer(await depsFor(repos), tcpOpts({ auth: bearerAuth("secret") }));
		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain('Bearer realm="warren"');
	});

	test("auth accepts the matching bearer token", async () => {
		handle = startServer(await depsFor(repos), tcpOpts({ auth: bearerAuth("secret") }));
		const res = await fetch(`${tcpUrl(handle)}/agents`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(res.status).toBe(200);
	});

	test("/version is auth-exempt and returns the package version (warren-6ea5)", async () => {
		handle = startServer(await depsFor(repos), tcpOpts({ auth: bearerAuth("secret") }));
		const res = await fetch(`${tcpUrl(handle)}/version`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { version: string };
		expect(body.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
	});

	test("/readyz still requires auth (body reveals failed checks)", async () => {
		handle = startServer(await depsFor(repos), tcpOpts({ auth: bearerAuth("secret") }));
		const res = await fetch(`${tcpUrl(handle)}/readyz`);
		expect(res.status).toBe(401);
	});

	test("UI shell, assets, and SPA deep links are auth-exempt (warren-d2a5)", async () => {
		// Without this, a fresh browser hitting `/` gets a 401 envelope and
		// the user can never reach Login.tsx to enter their bearer token.
		const distDir = setupUiDist();
		try {
			handle = startServer(
				await depsFor(repos, undefined, { uiDistDir: distDir }),
				tcpOpts({ auth: bearerAuth("secret") }),
			);
			const base = tcpUrl(handle);

			const root = await fetch(`${base}/`);
			expect(root.status).toBe(200);
			expect(root.headers.get("content-type")).toContain("text/html");
			expect(await root.text()).toContain("warren ui");

			const asset = await fetch(`${base}/assets/app.js`);
			expect(asset.status).toBe(200);
			expect(asset.headers.get("content-type")).toContain("text/javascript");

			// React Router deep link → falls through to index.html, no 401.
			const deep = await fetch(`${base}/login`);
			expect(deep.status).toBe(200);
			expect(await deep.text()).toContain("warren ui");

			// API endpoints stay gated.
			const agents = await fetch(`${base}/agents`);
			expect(agents.status).toBe(401);
		} finally {
			rmSync(distDir, { recursive: true, force: true });
		}
	});

	test("unknown path → 404 not_found envelope", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/nope`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("known path with wrong method → 405 method_not_allowed", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/agents`, { method: "PUT" });
		expect(res.status).toBe(405);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("method_not_allowed");
	});

	test("handler that throws WarrenError → mapped status + envelope", async () => {
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/boom",
				handler: () => {
					throw new ValidationError("nope", { recoveryHint: "fix it" });
				},
			},
		];
		handle = startServer(await depsFor(repos), tcpOpts({ routes }));
		const res = await fetch(`${tcpUrl(handle)}/boom`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; hint?: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.hint).toBe("fix it");
	});

	test("handler that throws plain Error → 500 internal_error", async () => {
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/boom",
				handler: () => {
					throw new Error("kaboom");
				},
			},
		];
		handle = startServer(await depsFor(repos), tcpOpts({ routes }));
		const res = await fetch(`${tcpUrl(handle)}/boom`);
		expect(res.status).toBe(500);
	});

	test("default idleTimeout=0 keeps a >10s-quiet streaming response alive (warren-b8fc)", async () => {
		// Bun.serve's default idleTimeout is 10s; without our override the
		// per-request timer would close this connection mid-stream and the
		// second chunk would never arrive. We pause 11s between chunks so
		// the fix being plumbed (idleTimeout: 0 default) is what makes the
		// assertion pass.
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/slow",
				handler: () =>
					new Response(
						new ReadableStream({
							async start(controller) {
								controller.enqueue(new TextEncoder().encode("a\n"));
								await new Promise((r) => setTimeout(r, 11_000));
								controller.enqueue(new TextEncoder().encode("b\n"));
								controller.close();
							},
						}),
						{ headers: { "content-type": "application/x-ndjson" } },
					),
			},
		];
		handle = startServer(await depsFor(repos), tcpOpts({ routes }));
		const res = await fetch(`${tcpUrl(handle)}/slow`);
		const body = await res.text();
		expect(body).toBe("a\nb\n");
	}, 15_000);
});

describe("startServer — routes", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { name: "refactor-bot", sections: { system: "x" } },
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("GET /agents returns the agents list", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agents: Array<{ name: string }> };
		expect(body.agents.length).toBe(1);
		expect(body.agents[0]?.name).toBe("refactor-bot");
	});

	test("GET /agents/:name returns the agent or 404", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());

		const ok = await fetch(`${tcpUrl(handle)}/agents/refactor-bot`);
		expect(ok.status).toBe(200);

		const missing = await fetch(`${tcpUrl(handle)}/agents/missing-bot`);
		expect(missing.status).toBe(404);
	});

	test("GET /projects returns the (empty) projects list", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/projects`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: unknown[] };
		expect(body.projects).toEqual([]);
	});

	test("GET /runs returns the empty runs list", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/runs`);
		expect(res.status).toBe(200);
		// warren-ee50 / pl-b0c0 step 1: paginated envelope shape.
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.runs).toEqual([]);
		expect(body.total).toBe(0);
		expect(body.costTotalUsd).toBe(0);
		expect(body.costPricedCount).toBe(0);
		expect(body.limit).toBe(100);
		expect(body.offset).toBe(0);
	});

	test("GET /runs?limit=0 rejects with ValidationError", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/runs?limit=0`);
		expect(res.status).toBe(400);
	});

	test("GET /runs?limit=501 rejects with ValidationError", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/runs?limit=501`);
		expect(res.status).toBe(400);
	});

	test("GET /runs?offset=-1 rejects with ValidationError", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/runs?offset=-1`);
		expect(res.status).toBe(400);
	});

	test("GET /runs/:id 404s on unknown id", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/runs/run_unknown`);
		expect(res.status).toBe(404);
	});

	test("GET /analytics/cost returns the empty analytics envelope (warren-cf63)", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/analytics/cost`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.totals).toEqual({ runs: 0, priced: 0, costUsd: 0 });
		const breakdowns = body.breakdowns as Record<string, unknown[]>;
		for (const dim of ["date", "project", "plan", "plot", "run", "agent", "model", "provider"]) {
			expect(breakdowns[dim]).toEqual([]);
		}
	});

	test("GET /analytics/cost rejects malformed ?from (warren-cf63)", async () => {
		handle = startServer(await depsFor(repos), tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/analytics/cost?from=not-a-date`);
		expect(res.status).toBe(400);
	});

	test("/readyz returns 503 when any mirrored check fails", async () => {
		// Empty agents + nonexistent canopy clone — readyz should be 503
		// and surface the failing checks by name.
		const dbEmpty = await openDatabase({ path: ":memory:" });
		const reposEmpty = createRepos(dbEmpty);
		try {
			handle = startServer(await depsFor(reposEmpty), tcpOpts());
			const res = await fetch(`${tcpUrl(handle)}/readyz`);
			expect(res.status).toBe(503);
			const body = (await res.json()) as {
				ok: boolean;
				checks: { name: string; ok: boolean }[];
			};
			expect(body.ok).toBe(false);
			const names = body.checks.map((c) => c.name);
			expect(names).toContain("burrow_reachable");
			expect(names).toContain("agents");
			expect(names).toContain("canopy_clone");
			expect(names).toContain("canopy_clean");
			expect(names).toContain("bwrap");
			expect(names).toContain("warren_config");
			expect(body.checks.find((c) => c.name === "agents")?.ok).toBe(false);
			expect(body.checks.find((c) => c.name === "canopy_clone")?.ok).toBe(false);
		} finally {
			await handle?.stop();
			handle = null;
			await dbEmpty.close();
		}
	});

	test("/readyz returns 200 when every mirrored check passes", async () => {
		// Existing canopy clone + at least one agent registered + burrow
		// probe succeeds (stubbed) + bwrap + canopy_clean stubbed clean.
		const canopyDir = mkdtempSync(join(tmpdir(), "warren-readyz-"));
		try {
			handle = startServer(await depsFor(repos, undefined, { canopyDir, db }), tcpOpts());
			const res = await fetch(`${tcpUrl(handle)}/readyz`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				ok: boolean;
				checks: { name: string; ok: boolean; message?: string }[];
			};
			expect(body.ok).toBe(true);
			expect(body.checks.every((c) => c.ok)).toBe(true);
			const dbCheck = body.checks.find((c) => c.name === "db_reachable");
			expect(dbCheck?.ok).toBe(true);
			expect(dbCheck?.message).toBe("dialect=sqlite");
		} finally {
			await handle?.stop();
			handle = null;
			rmSync(canopyDir, { recursive: true, force: true });
		}
	});

	test("/readyz flags bwrap when the probe fails", async () => {
		const canopyDir = mkdtempSync(join(tmpdir(), "warren-readyz-bwrap-"));
		const failBwrap: SpawnFn = async (cmd) => {
			if (cmd[0]?.endsWith("bwrap")) {
				return { stdout: "", stderr: "command not found", exitCode: 127 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		try {
			handle = startServer(
				await depsFor(repos, undefined, { canopyDir, spawn: failBwrap }),
				tcpOpts(),
			);
			const res = await fetch(`${tcpUrl(handle)}/readyz`);
			expect(res.status).toBe(503);
			const body = (await res.json()) as {
				ok: boolean;
				checks: { name: string; ok: boolean; hint?: string }[];
			};
			const bwrap = body.checks.find((c) => c.name === "bwrap");
			expect(bwrap?.ok).toBe(false);
			expect(bwrap?.hint).toContain("bubblewrap");
		} finally {
			await handle?.stop();
			handle = null;
			rmSync(canopyDir, { recursive: true, force: true });
		}
	});

	test("/readyz returns 200 with no canopy library configured (warren-d3e9)", async () => {
		// Strip canopyConfig — equivalent to booting without CANOPY_REPO_URL.
		// canopy_clone / canopy_clean become informational `ok: true` and
		// the agents check passes because the test fixture seeded one row.
		const deps = await depsFor(repos);
		const noCanopyDeps: ServerDeps = {
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			bridges: deps.bridges,
			projectsConfig: deps.projectsConfig,
			logger: deps.logger,
			uiDistDir: deps.uiDistDir,
			...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
		};
		handle = startServer(noCanopyDeps, tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/readyz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			checks: { name: string; ok: boolean; message?: string }[];
		};
		expect(body.ok).toBe(true);
		const canopyClone = body.checks.find((c) => c.name === "canopy_clone");
		expect(canopyClone?.ok).toBe(true);
		expect(canopyClone?.message).toContain("no canopy library configured");
	});

	test("/readyz flags canopy_clean when git status reports dirt", async () => {
		const canopyDir = mkdtempSync(join(tmpdir(), "warren-readyz-dirty-"));
		const dirtySpawn: SpawnFn = async (cmd) => {
			if (cmd[0]?.endsWith("bwrap")) {
				return { stdout: "bubblewrap 0.8.0\n", stderr: "", exitCode: 0 };
			}
			if (cmd.includes("status") && cmd.includes("--porcelain")) {
				return { stdout: " M agents/foo.md\n?? scratch.txt\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		try {
			handle = startServer(
				await depsFor(repos, undefined, { canopyDir, spawn: dirtySpawn }),
				tcpOpts(),
			);
			const res = await fetch(`${tcpUrl(handle)}/readyz`);
			expect(res.status).toBe(503);
			const body = (await res.json()) as {
				ok: boolean;
				checks: { name: string; ok: boolean; message?: string }[];
			};
			const clean = body.checks.find((c) => c.name === "canopy_clean");
			expect(clean?.ok).toBe(false);
			expect(clean?.message).toContain("2 local mutation");
		} finally {
			await handle?.stop();
			handle = null;
			rmSync(canopyDir, { recursive: true, force: true });
		}
	});
});

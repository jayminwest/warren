import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

/**
 * Run-related handler tests, extracted from `src/server/handlers.test.ts`
 * (warren-a2b4 / pl-9088 step 2). Covers POST /runs (spawn + plot_id
 * validation + interactive mode), POST /runs/:id/messages (interactive
 * follow-up turn), and GET /runs/:id/events (NDJSON tail).
 */

/**
 * Build a single-worker `BurrowClientPool` from a stubbed `BurrowClient`
 * so `POST /runs` and `POST /projects/:id/triggers/:triggerId/run` can
 * route through `spawnRun`'s placement seam (warren-39c3). Upserts the
 * synthetic `local` worker row so `placeForProject` has a healthy
 * candidate.
 */
async function poolFor(repos: Repos, client: BurrowClient): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register("local", client);
	return pool;
}

const silentLogger = {
	info() {},
	warn() {},
	error() {},
};

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

interface BurrowFixture {
	burrowId: string;
	burrowRunId: string;
	workspacePath: string;
}

function makeBurrowClient(
	fix: BurrowFixture,
	calls: { method: string; path: string; body: unknown }[],
): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path, body: reqBody });
			if (method === "POST" && path === "/burrows") {
				const burrow = {
					id: fix.burrowId,
					name: "burrow",
					kind: "task",
					projectRoot: "/data/projects/x/y",
					branch: "main",
					baseBranch: "main",
					originUrl: "https://github.com/x/y.git",
					workspacePath: fix.workspacePath,
					provider: "local",
					sandbox: { network: "open" },
					state: "running",
					createdAt: "2026-05-08T12:00:00Z",
					updatedAt: "2026-05-08T12:00:00Z",
				};
				return new Response(JSON.stringify(burrow), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			if (method === "POST" && path === `/burrows/${fix.burrowId}/runs`) {
				const run = {
					id: fix.burrowRunId,
					burrowId: fix.burrowId,
					agentId: "refactor-bot",
					prompt: "hello",
					resumeOfRunId: null,
					state: "queued",
					exitCode: null,
					errorMessage: null,
					metadataJson: null,
					queuedAt: "2026-05-08T12:00:01Z",
					startedAt: null,
					completedAt: null,
				};
				return new Response(JSON.stringify(run), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ error: { code: "not_found", message: `unmatched ${method} ${path}` } }),
				{
					status: 404,
					headers: { "content-type": "application/json" },
				},
			);
		}),
	});
}

async function depsFor(
	repos: Repos,
	burrowClient: BurrowClient,
	bridges?: BridgeRegistry,
	extras?: { plotResolver?: import("../../plots/index.ts").PlotResolver },
): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const burrowClientPool = await poolFor(repos, burrowClient);
	return {
		repos,
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
			localDir: "/tmp/cn",
			cnBinary: "cn",
			gitBinary: "git",
		},
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		// No-op spawn so the project-refresh path inside `POST /runs` and
		// `POST /projects/:id/refresh` doesn't shell out to real `git`
		// against tmpdir paths the test never populated. Tests that need
		// to assert on spawn calls override `deps.spawn` directly.
		spawn: async (cmd) => {
			if (cmd[1] === "rev-parse") {
				return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		...(extras?.plotResolver !== undefined ? { plotResolver: extras.plotResolver } : {}),
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("POST /runs — spawn flow", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	let projectLocalPath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});

		// Real on-disk localPath so the project-refresh path inside POST
		// /runs (warren-1bb6) can pass its existsSync probe before the
		// stubbed spawn handles git fetch + reset --hard origin/main.
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-handlers-proj-"));

		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("provisions burrow, dispatches run, returns 201 + run id, registers a bridge", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		// Use a real tmpdir for the burrow workspace so the handler's seed
		// step (real disk write into <ws>/.canopy/agent.json) doesn't fail.
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: tmpWs },
			calls,
		);

		// Stub bridge so the handler's deps.bridges.start() lands in our
		// registry without needing a real burrow stream.
		const bridgeStarted: { runId: string; burrowRunId: string }[] = [];
		const bridges: BridgeRegistry = {
			start: (runId, burrowRunId) => {
				bridgeStarted.push({ runId, burrowRunId });
			},
			stopAll: async () => {},
			size: () => bridgeStarted.length,
		};
		const deps = await depsFor(repos, burrowClient, bridges);

		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			run: { id: string; state: string };
			burrow: { id: string };
		};
		expect(body.run.id).toMatch(/^run_/);
		expect(body.run.state).toBe("queued");
		expect(body.burrow.id).toBe("bur_xxxxxxxxxxxx");
		expect(bridgeStarted.length).toBe(1);
		expect(bridgeStarted[0]?.burrowRunId).toBe("run_zzzzzzzzzzzz");
		expect(calls.some((c) => c.method === "POST" && c.path === "/burrows")).toBe(true);
		expect(calls.some((c) => c.path === "/burrows/bur_xxxxxxxxxxxx/runs")).toBe(true);
	});

	test("optional seedId persists onto runs.seed_id (warren-805a)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-seedid-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_seed00000000", burrowRunId: "run_seedrun00000", workspacePath: tmpWs },
			calls,
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				seedId: "warren-805a",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string } };
		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.seedId).toBe("warren-805a");
	});

	test("seedId omitted → runs.seed_id stays null", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-noseed-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_noseed0000000", burrowRunId: "run_noseedrun0000", workspacePath: tmpWs },
			calls,
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string } };
		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.seedId).toBeNull();
	});

	test("missing required field → 400 validation_error", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: "refactor-bot", project: "prj_x" }), // missing prompt
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("empty body → 400 validation_error", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, { method: "POST" });
		expect(res.status).toBe(400);
	});
});

describe("POST /runs — plot_id format + existence validation (warren-bae5)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-handlers-plotvalid-"));
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
			hasPlot: true,
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function makeHandle(
		resolver?: import("../../plots/index.ts").PlotResolver,
	): Promise<{ project: { id: string }; handle: ServeHandle }> {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-plotvalid-ws-"));
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_plotvalid000", burrowRunId: "run_plotvalid000", workspacePath: tmpWs },
			calls,
		);
		const deps = await depsFor(
			repos,
			burrowClient,
			undefined,
			resolver !== undefined ? { plotResolver: resolver } : undefined,
		);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return { project, handle };
	}

	test("malformed plot_id ('plot_id=plot-3e72876d') → 400 plot_id_invalid (the bug from warren-a353)", async () => {
		const { project } = await makeHandle();
		if (handle === null) throw new Error("handle missing");
		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				plotId: "plot_id=plot-3e72876d",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; hint?: string } };
		expect(body.error.code).toBe("plot_id_invalid");
	});

	test("well-formed but non-existent plot_id → 400 plot_id_not_found", async () => {
		const resolver = {
			async resolve() {
				return null;
			},
		};
		const { project } = await makeHandle(resolver);
		if (handle === null) throw new Error("handle missing");
		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				plotId: "plot-deadbeef",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("plot_id_not_found");
	});

	test("well-formed + resolver hit → 201 (happy path)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const resolver = {
			async resolve() {
				return project;
			},
		};
		await makeHandle(resolver);
		if (handle === null) throw new Error("handle missing");
		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				plotId: "plot-3e72876d",
			}),
		});
		expect(res.status).toBe(201);
	});

	test("omitted plot_id is byte-identical to current behavior (no validation kicks in)", async () => {
		const { project } = await makeHandle({
			async resolve() {
				throw new Error("resolver should not be consulted when plot_id is omitted");
			},
		});
		if (handle === null) throw new Error("handle missing");
		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
			}),
		});
		expect(res.status).toBe(201);
	});

	test("empty-string plot_id is treated as not supplied (no validation kicks in)", async () => {
		const { project } = await makeHandle({
			async resolve() {
				throw new Error("resolver should not be consulted when plot_id is empty");
			},
		});
		if (handle === null) throw new Error("handle missing");
		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				plotId: "",
			}),
		});
		expect(res.status).toBe(201);
	});
});

describe("GET /runs/:id/events — NDJSON tail", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "x", renderedJson: { name: "x" } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "x",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { name: "x", sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.events.append({
			runId: run.id,
			burrowEventSeq: 1,
			ts: "2026-05-08T12:00:00Z",
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "bash" },
		});
		await repos.events.append({
			runId: run.id,
			burrowEventSeq: 2,
			ts: "2026-05-08T12:00:01Z",
			kind: "tool_result",
			stream: "stdout",
			payload: { ok: true },
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("non-follow returns the events as NDJSON", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		expect(lines.length).toBe(2);
		const first = JSON.parse(lines[0] ?? "{}") as { kind: string; seq: number };
		expect(first.kind).toBe("tool_use");
		expect(first.seq).toBe(1);
	});

	test("404 on unknown run id", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/run_unknown/events`);
		expect(res.status).toBe(404);
	});

	test("event envelopes carry the run's plotId (warren-a8c3)", async () => {
		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		// Backfill plot_id directly — the run was created before the project
		// flipped hasPlot. Spawn-side validation is covered by spawn.test.ts.
		db.raw.exec(`UPDATE runs SET plot_id = 'plot-2047abc1' WHERE id = '${run.id}'`);

		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events`);
		expect(res.status).toBe(200);
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		for (const line of lines) {
			const env = JSON.parse(line) as { plotId: string | null };
			expect(env.plotId).toBe("plot-2047abc1");
		}
	});

	test("plotId is null on the envelope when the run has no plot (warren-a8c3)", async () => {
		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");

		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events`);
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			const env = JSON.parse(line) as { plotId: string | null };
			expect(env.plotId).toBeNull();
		}
	});
});

describe("POST /runs — interactive mode (warren-b3b9)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let project: { id: string } | undefined;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "brainstorm",
			renderedJson: {
				name: "brainstorm",
				version: 1,
				sections: { system: "you are brainstorm" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		await repos.agents.upsert({
			name: "planner",
			renderedJson: {
				name: "planner",
				version: 1,
				sections: { system: "you are planner" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-interactive-"));
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
			hasPlot: true,
		});
		project = (await repos.projects.listAll())[0];
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function bootWithPlotResolver(): Promise<ServeHandle> {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-interactive-ws-"));
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{
				burrowId: "bur_interactive00",
				burrowRunId: "run_interactive0",
				workspacePath: tmpWs,
			},
			calls,
		);
		const proj = project;
		const resolver: import("../../plots/index.ts").PlotResolver = {
			async resolve() {
				if (proj === undefined) return null;
				return (await repos.projects.get(proj.id)) ?? null;
			},
		};
		const deps = await depsFor(repos, burrowClient, undefined, { plotResolver: resolver });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return handle;
	}

	test("mode='interactive' without plotId → 400 validation_error", async () => {
		const h = await bootWithPlotResolver();
		const res = await fetch(`${tcpUrl(h)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: "interactive",
				agent: "brainstorm",
				project: project?.id,
				prompt: "let's brainstorm",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("plotId is required");
	});

	test("invalid mode value → 400 validation_error", async () => {
		const h = await bootWithPlotResolver();
		const res = await fetch(`${tcpUrl(h)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: "chat",
				agent: "brainstorm",
				project: project?.id,
				prompt: "x",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("mode");
	});

	test("mode='interactive' + plotId + interactiveAgent → 201, mode persisted, user_message event appended", async () => {
		const h = await bootWithPlotResolver();
		const res = await fetch(`${tcpUrl(h)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: "interactive",
				// `agent` is supplied to satisfy requireString, but
				// interactiveAgent overrides it on interactive dispatch.
				agent: "planner",
				interactiveAgent: "brainstorm",
				project: project?.id,
				prompt: "let's brainstorm an idea",
				plotId: "plot-3e72876d",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string; mode: string; agentName: string } };
		expect(body.run.mode).toBe("interactive");
		expect(body.run.agentName).toBe("brainstorm");
		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.mode).toBe("interactive");
		expect(persisted.plotId).toBe("plot-3e72876d");
		const events = await repos.events.listByRunIds([body.run.id]);
		const userMsg = events.find((e) => e.kind === "user_message");
		expect(userMsg).toBeDefined();
		expect((userMsg?.payloadJson as { content: string }).content).toBe("let's brainstorm an idea");
	});

	test("mode omitted → batch (default), no user_message event appended", async () => {
		const h = await bootWithPlotResolver();
		const res = await fetch(`${tcpUrl(h)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "brainstorm",
				project: project?.id,
				prompt: "hello",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string; mode: string } };
		expect(body.run.mode).toBe("batch");
		const events = await repos.events.listByRunIds([body.run.id]);
		expect(events.some((e) => e.kind === "user_message")).toBe(false);
	});
});

describe("POST /runs/:id/messages — interactive follow-up turn (warren-b3b9)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "brainstorm",
			renderedJson: {
				name: "brainstorm",
				version: 1,
				sections: { system: "you are brainstorm" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-interactive-msg-"));
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
			hasPlot: true,
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("404 when prior run id is unknown", async () => {
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_x", burrowRunId: "run_x", workspacePath: "/tmp/ws" },
			[],
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/runs/run_doesnotexist/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "follow-up" }),
		});
		expect(res.status).toBe(404);
	});

	test("400 when prior run is not mode='interactive'", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		// Insert a batch run row directly so we can hit the
		// mode-mismatch reject without spawning.
		const run = await repos.runs.create({
			projectId: project.id,
			agentName: "brainstorm",
			renderedAgentJson: {
				name: "brainstorm",
				version: 1,
				sections: { system: "x" },
				resolvedFrom: [],
				frontmatter: {},
			},
			prompt: "x",
			trigger: "manual",
			mode: "batch",
			workerId: "local",
		});
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_y", burrowRunId: "run_y", workspacePath: "/tmp/ws2" },
			[],
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "follow-up" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("interactive");
	});

	test("400 when message body is missing", async () => {
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_z", burrowRunId: "run_z", workspacePath: "/tmp/ws3" },
			[],
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/runs/run_x/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});
});

/* ----------------------------------------------------------------------- */
/* POST /brainstorm (warren-d22e / pl-0344 step 8)                          */
/* ----------------------------------------------------------------------- */

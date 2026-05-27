import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "./types.ts";

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
	extras?: { plotResolver?: import("../plots/index.ts").PlotResolver },
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

describe("POST /projects/:id/refresh — git fetch + hard reset", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-refresh-proj-"));

		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
		projectId = row.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("refreshes the clone, stamps lastFetchedAt + lastHeadSha, returns 200", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/refresh`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			project: { id: string; lastHeadSha: string | null; lastFetchedAt: string | null };
			headSha: string;
			ref: string;
		};
		expect(body.project.id).toBe(projectId);
		expect(body.headSha).toBe("deadbeef".repeat(5));
		expect(body.ref).toBe("main");
		expect(body.project.lastHeadSha).toBe("deadbeef".repeat(5));
		expect(body.project.lastFetchedAt).not.toBeNull();
	});

	test("forwards an explicit ref into the refresh", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const seenRefs: string[] = [];
		const deps: ServerDeps = {
			...(await depsFor(repos, burrowClient)),
			spawn: async (cmd) => {
				if (cmd[1] === "checkout") {
					seenRefs.push(cmd[3] ?? "");
				}
				if (cmd[1] === "rev-parse") {
					return { stdout: "abc1234".padEnd(40, "0"), stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/refresh`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ref: "feature/x" }),
		});
		expect(res.status).toBe(200);
		expect(seenRefs).toEqual(["feature/x"]);
	});

	test("returns 404 for an unknown project id", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/refresh`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /projects/:id/warren-config — per-project .warren/ envelope (warren-435b)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-wcfg-proj-"));

		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
		projectId = row.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("returns null fields + empty errors when .warren/ is absent", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/warren-config`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: unknown;
			defaults: unknown;
			errors: unknown[];
		};
		expect(body.triggers).toBeNull();
		expect(body.defaults).toBeNull();
		expect(body.errors).toEqual([]);
	});

	test("returns parsed triggers + defaults when both files are valid", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  seed: warren-1\n  role: refactor-bot\n",
		);
		await writeFile(
			join(projectLocalPath, ".warren", "defaults.json"),
			JSON.stringify({ defaultBranch: "main", defaultRole: "refactor-bot" }),
		);

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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/warren-config`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: { id: string; kind: string; cron: string }[] | null;
			defaults: { defaultBranch?: string; defaultRole?: string } | null;
			errors: unknown[];
		};
		expect(body.errors).toEqual([]);
		expect(body.triggers?.[0]?.id).toBe("nightly");
		expect(body.triggers?.[0]?.cron).toBe("0 2 * * *");
		expect(body.defaults?.defaultBranch).toBe("main");
		expect(body.defaults?.defaultRole).toBe("refactor-bot");
	});

	test("collects per-file errors when a file is malformed", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		// Schema violation: missing required `seed` and `role`.
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n",
		);
		// JSON parse error.
		await writeFile(join(projectLocalPath, ".warren", "defaults.json"), "{not-json");

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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/warren-config`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: unknown;
			defaults: unknown;
			errors: { file: string; code: string; message: string }[];
		};
		expect(body.triggers).toBeNull();
		expect(body.defaults).toBeNull();
		expect(body.errors.length).toBe(2);
		const triggersErr = body.errors.find((e) => e.file === ".warren/triggers.yaml");
		const defaultsErr = body.errors.find((e) => e.file === ".warren/defaults.json");
		expect(triggersErr?.code).toBe("warren_config_schema_error");
		expect(defaultsErr?.code).toBe("warren_config_parse_error");
	});

	test("returns 404 for an unknown project id", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/warren-config`);
		expect(res.status).toBe(404);
	});

	test("returns 503 when the project clone is missing on disk", async () => {
		const { rm } = await import("node:fs/promises");
		await rm(projectLocalPath, { recursive: true, force: true });

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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/warren-config`);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("warren_config_unavailable");
	});
});

describe("GET /agents — listing with source provenance (warren-d3e9)", () => {
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

	test("returns source: 'builtin' when frontmatter.source === 'builtin'", async () => {
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: ["builtin:claude-code"],
				frontmatter: { source: "builtin" },
			},
		});
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

		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agents: { name: string; source: string }[] };
		expect(body.agents[0]?.source).toBe("builtin");
	});

	test("returns source: 'library' for canopy-loaded rows (no source frontmatter)", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
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

		const res = await fetch(`${tcpUrl(handle)}/agents`);
		const body = (await res.json()) as { agents: { name: string; source: string }[] };
		expect(body.agents[0]?.source).toBe("library");
	});
});

describe("POST /agents/refresh without canopy library (warren-d3e9)", () => {
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

	test("returns 400 with friendly hint when canopyConfig is undefined", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		// Strip canopyConfig — equivalent to booting without CANOPY_REPO_URL.
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
		handle = startServer(noCanopyDeps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/agents/refresh`, { method: "POST" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; hint?: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.hint).toContain("CANOPY_REPO_URL");
	});
});

describe("GET /projects/:id/triggers — parsed YAML joined with scheduler state (warren-99c3)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-triggers-get-"));

		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
		projectId = row.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("empty list + empty errors when .warren/ is absent", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { triggers: unknown[]; errors: unknown[] };
		expect(body.triggers).toEqual([]);
		expect(body.errors).toEqual([]);
	});

	test("joins parsed YAML with persisted last/next/lastRunId and freshly-computed nextFireAt", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  seed: warren-1\n  role: refactor-bot\n",
		);

		// Seed an agent + run so the scheduler row's lastRunId FK resolves.
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const seedRun = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: { name: "refactor-bot", sections: { system: "..." } },
			trigger: "cron",
		});

		// Pre-populate the scheduler row so the join surfaces lastFiredAt +
		// lastRunId. Persisted nextFireAt is intentionally stale so the
		// freshly-computed value beats it on the wire.
		await repos.triggers.upsert({
			projectId,
			triggerId: "nightly",
			lastFiredAt: "2026-05-09T02:00:00.000Z",
			nextFireAt: "2026-05-10T02:00:00.000Z",
			lastRunId: seedRun.id,
		});

		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps: ServerDeps = {
			...(await depsFor(repos, burrowClient)),
			// Freeze "now" so the recomputed nextFireAt is deterministic.
			now: () => new Date("2026-05-10T12:00:00.000Z"),
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: {
				id: string;
				kind: string;
				cron: string;
				seed: string;
				role: string;
				lastFiredAt: string | null;
				nextFireAt: string | null;
				lastRunId: string | null;
				parseError: string | null;
			}[];
			errors: unknown[];
		};
		expect(body.errors).toEqual([]);
		expect(body.triggers.length).toBe(1);
		const t = body.triggers[0];
		expect(t?.id).toBe("nightly");
		expect(t?.cron).toBe("0 2 * * *");
		expect(t?.seed).toBe("warren-1");
		expect(t?.role).toBe("refactor-bot");
		expect(t?.lastFiredAt).toBe("2026-05-09T02:00:00.000Z");
		expect(t?.lastRunId).toBe(seedRun.id);
		// Next fire is 2026-05-11T02:00:00Z (next 02:00 UTC after frozen now).
		expect(t?.nextFireAt).toBe("2026-05-11T02:00:00.000Z");
		expect(t?.parseError).toBeNull();
	});

	test("surfaces YAML schema errors in the errors envelope", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		// Schema violation: missing required `seed` and `role`.
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n",
		);

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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: unknown[];
			errors: { file: string; code: string }[];
		};
		expect(body.triggers).toEqual([]);
		expect(body.errors.length).toBe(1);
		expect(body.errors[0]?.file).toBe(".warren/triggers.yaml");
		expect(body.errors[0]?.code).toBe("warren_config_schema_error");
	});

	test("404 for an unknown project id", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/triggers`);
		expect(res.status).toBe(404);
	});
});

describe("POST /projects/:id/triggers/:triggerId/run — manual Run Now (warren-99c3)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let projectId = "";

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
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-triggers-run-"));

		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
		projectId = row.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("dispatches the named trigger, returns 201, records fire + bridge", async () => {
		const { mkdir, writeFile, mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  seed: warren-1\n  role: refactor-bot\n  prompt: 'hand-rolled prompt'\n",
		);

		const tmpWs = await mkdtemp(join(tmpdir(), "warren-triggers-ws-"));
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: tmpWs },
			calls,
		);

		const bridgeStarted: { runId: string; burrowRunId: string }[] = [];
		const bridges: BridgeRegistry = {
			start: (runId, burrowRunId) => {
				bridgeStarted.push({ runId, burrowRunId });
			},
			stopAll: async () => {},
			size: () => bridgeStarted.length,
		};
		const deps: ServerDeps = {
			...(await depsFor(repos, burrowClient, bridges)),
			now: () => new Date("2026-05-10T12:00:00.000Z"),
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers/nightly/run`, {
			method: "POST",
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			run: { id: string; trigger: string; agentName: string; prompt: string };
			burrow: { id: string; workspacePath: string };
		};
		expect(body.run.id).toMatch(/^run_/);
		expect(body.run.trigger).toBe("manual-trigger");
		expect(body.run.agentName).toBe("refactor-bot");
		expect(body.run.prompt).toBe("hand-rolled prompt");
		expect(body.burrow.id).toBe("bur_xxxxxxxxxxxx");
		expect(bridgeStarted.length).toBe(1);
		expect(bridgeStarted[0]?.burrowRunId).toBe("run_zzzzzzzzzzzz");

		// Triggers row stamped with manual fire + nextFireAt rolled forward.
		const row = await repos.triggers.get({ projectId, triggerId: "nightly" });
		expect(row?.lastFiredAt).toBe("2026-05-10T12:00:00.000Z");
		expect(row?.nextFireAt).toBe("2026-05-11T02:00:00.000Z");
		expect(row?.lastRunId).toBe(body.run.id);
	});

	test("404 when the trigger id is not in .warren/triggers.yaml", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  seed: warren-1\n  role: refactor-bot\n",
		);

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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers/missing/run`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("404 when the project id is unknown", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/triggers/nightly/run`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
	});
});

describe("POST /projects/:id/agents/refresh — per-project .canopy/ tier (R-03)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";
	let projectLocalPath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		// localPath must be a real, writable directory because the
		// project-tier refresh now mirrors each rendered agent into
		// `<localPath>/.canopy/.rendered/<name>.json` (warren-44e3).
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-44e3-proj-"));
		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
		projectId = row.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
		if (projectLocalPath) {
			const { rm } = await import("node:fs/promises");
			await rm(projectLocalPath, { recursive: true, force: true });
			projectLocalPath = "";
		}
	});

	function canopySpawnStub(
		listResp: unknown,
		renderResponses: Record<string, unknown>,
	): ServerDeps["spawn"] {
		return async (cmd) => {
			if (cmd[1] === "list" && cmd.includes("agent")) {
				return { stdout: JSON.stringify(listResp), stderr: "", exitCode: 0 };
			}
			if (cmd[1] === "render") {
				const name = cmd[2] as string;
				const body = renderResponses[name];
				if (body === undefined) {
					return { stdout: "", stderr: `unhandled render ${name}`, exitCode: 2 };
				}
				return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};
	}

	test("renders the project's .canopy/, stamps source=project:<id>, returns 200", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps: ServerDeps = {
			...(await depsFor(repos, burrowClient)),
			spawn: canopySpawnStub(
				{
					success: true,
					command: "list",
					prompts: [{ name: "refactor-bot", version: 1, status: "active" }],
				},
				{
					"refactor-bot": {
						success: true,
						command: "render",
						name: "refactor-bot",
						version: 1,
						sections: [{ name: "system", body: "you are refactor-bot (project tier)" }],
					},
				},
			),
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/agents/refresh`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			projectId: string;
			registered: { name: string; source: string; projectId: string | null }[];
			skipped: unknown[];
			removed: string[];
		};
		expect(body.projectId).toBe(projectId);
		expect(body.registered).toHaveLength(1);
		expect(body.registered[0]?.name).toBe("refactor-bot");
		expect(body.registered[0]?.source).toBe(`project:${projectId}`);
		expect(body.registered[0]?.projectId).toBe(projectId);
		expect(body.skipped).toEqual([]);
		expect(body.removed).toEqual([]);

		// Global tier untouched — same-named global row would persist as-is.
		expect(await repos.agents.get("refactor-bot")).toBeNull();
		const projectRow = await repos.agents.require("refactor-bot", { projectId });
		expect(projectRow.projectId).toBe(projectId);

		// On-disk rendered cache (warren-44e3 follow-up to R-03): the project's
		// `.canopy/.rendered/` is populated alongside the agents-table cache
		// so `cn render` outside warren can see the resolved agent.
		const { readFile, readdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const cacheDir = join(projectLocalPath, ".canopy", ".rendered");
		const entries = (await readdir(cacheDir)).sort();
		expect(entries).toEqual([".gitignore", "refactor-bot.json"]);
		const cached = JSON.parse(await readFile(join(cacheDir, "refactor-bot.json"), "utf8")) as {
			name: string;
			frontmatter: { source: string };
		};
		expect(cached.name).toBe("refactor-bot");
		expect(cached.frontmatter.source).toBe(`project:${projectId}`);
	});

	test("returns 404 for an unknown project id", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/agents/refresh`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /agents and /agents/:name — projectId filter (R-03)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = row.id;
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: ["builtin:claude-code"],
				frontmatter: { source: "builtin" },
			},
		});
		await repos.agents.upsert({
			name: "refactor-bot",
			projectId,
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: [],
				frontmatter: { source: `project:${projectId}` },
			},
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("GET /agents (no filter) returns global rows only", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agents: { name: string; source: string }[] };
		expect(body.agents.map((a) => a.name)).toEqual(["claude-code"]);
	});

	test("GET /agents?projectId=<id> returns global ∪ project tier", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/agents?projectId=${encodeURIComponent(projectId)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			agents: { name: string; source: string; projectId: string | null }[];
		};
		expect(body.agents.map((a) => a.name).sort()).toEqual(["claude-code", "refactor-bot"]);
		const refactor = body.agents.find((a) => a.name === "refactor-bot");
		expect(refactor?.source).toBe(`project:${projectId}`);
		expect(refactor?.projectId).toBe(projectId);
	});

	test("GET /agents?projectId= (empty) → 400 validation_error", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/agents?projectId=`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("GET /agents/:name?projectId=<id> prefers project tier when both exist", async () => {
		// Same-named global row alongside the project-tier refactor-bot.
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: [],
				frontmatter: { source: "library" },
			},
		});

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

		const res = await fetch(
			`${tcpUrl(handle)}/agents/refactor-bot?projectId=${encodeURIComponent(projectId)}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string; source: string; projectId: string | null };
		expect(body.source).toBe(`project:${projectId}`);
		expect(body.projectId).toBe(projectId);
	});

	test("GET /agents/:name?projectId=<id> falls back to global when no project row", async () => {
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

		const res = await fetch(
			`${tcpUrl(handle)}/agents/claude-code?projectId=${encodeURIComponent(projectId)}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string; source: string; projectId: string | null };
		expect(body.name).toBe("claude-code");
		expect(body.source).toBe("builtin");
		expect(body.projectId).toBeNull();
	});

	test("GET /agents/:name?projectId=<id> → 404 when neither tier has the agent", async () => {
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

		const res = await fetch(
			`${tcpUrl(handle)}/agents/missing-bot?projectId=${encodeURIComponent(projectId)}`,
		);
		expect(res.status).toBe(404);
	});
});

describe("GET /projects/:id/seeds/:seedId — single-seed status read (warren-4015)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let seedyProjectId = "";
	let bareProjectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const seedy = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy-warren-4015",
			defaultBranch: "main",
			hasSeeds: true,
		});
		seedyProjectId = seedy.id;
		const bare = await repos.projects.create({
			gitUrl: "https://github.com/x/bare.git",
			localPath: "/tmp/bare-warren-4015",
			defaultBranch: "main",
			hasSeeds: false,
		});
		bareProjectId = bare.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	function depsWithSdSpawn(
		burrowClient: BurrowClient,
		sdSpawn: (
			cmd: readonly string[],
		) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
	): Promise<ServerDeps> {
		return (async () => {
			const base = await depsFor(repos, burrowClient);
			return {
				...base,
				seedsCli: { sdBinary: "sd", spawn: sdSpawn },
			};
		})();
	}

	test("returns {id, status, blockedBy} for an open seed", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsWithSdSpawn(burrowClient, async () => ({
			stdout: JSON.stringify({
				success: true,
				issue: { id: "warren-abcd", status: "open", blockedBy: [] },
			}),
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/warren-abcd`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; status: string; blockedBy: string[] };
		expect(body.id).toBe("warren-abcd");
		expect(body.status).toBe("open");
		expect(body.blockedBy).toEqual([]);
	});

	test("returns status='closed' so the UI can drop the seed from BatchDispatch", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsWithSdSpawn(burrowClient, async () => ({
			stdout: JSON.stringify({
				success: true,
				issue: { id: "warren-zzzz", status: "closed" },
			}),
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/warren-zzzz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; status: string; blockedBy: string[] };
		expect(body.status).toBe("closed");
		expect(body.blockedBy).toEqual([]);
	});

	test("404 for unknown project id", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsWithSdSpawn(burrowClient, async () => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_missing/seeds/warren-1`);
		expect(res.status).toBe(404);
	});

	test("400 ProjectLacksSeedsError when project has no .seeds/", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsWithSdSpawn(burrowClient, async () => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${bareProjectId}/seeds/warren-1`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_seeds");
	});

	test("400 ValidationError when seeds CLI is not configured on warren", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		// `depsFor` does NOT set seedsCli, so this exercises the
		// "warren has no sd configured" path.
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/warren-1`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});
});

/* ----------------------------------------------------------------------- */
/* POST /runs mode='interactive' + POST /runs/:id/messages                  */
/* (pl-0344 step 4 / warren-b3b9)                                          */
/* ----------------------------------------------------------------------- */

describe("POST /brainstorm", () => {
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
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-brainstorm-"));
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

	test("draft-from-zero: creates a Plot and dispatches an interactive brainstorm run", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-brainstorm-ws-"));
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_brainstorm00", burrowRunId: "run_brainstorm00", workspacePath: tmpWs },
			calls,
		);
		// Stub plotCreator so we don't need a real .plot/ directory.
		const created = {
			id: "plot-brainstorm0",
			name: "Untitled brainstorm",
			status: "drafting" as const,
			intent_goal_preview: "",
			attachments_count: 0,
			last_event_ts: "2026-05-23T00:00:00Z",
			last_event_actor: "user:operator",
		};
		const creatorCalls: Array<{ name: string; intent: unknown }> = [];
		const plotCreator: import("../plots/index.ts").PlotCreator = {
			async create(input) {
				creatorCalls.push({ name: input.name, intent: input.intent });
				return created;
			},
		};
		const deps = await depsFor(repos, burrowClient);
		const depsWithCreator: ServerDeps = { ...deps, plotCreator };
		handle = startServer(depsWithCreator, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/brainstorm`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: project.id,
				prompt: "I want to ship a self-hostable warren tutorial",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			plot: { id: string; status: string; project_id: string };
			run: { id: string; mode: string; agentName: string; plotId: string };
			burrow: { id: string };
		};
		// Plot was created with default name + empty intent.
		expect(body.plot.id).toBe("plot-brainstorm0");
		expect(body.plot.status).toBe("drafting");
		expect(body.plot.project_id).toBe(project.id);
		expect(creatorCalls).toHaveLength(1);
		expect(creatorCalls[0]?.name).toBe("Untitled brainstorm");
		expect(creatorCalls[0]?.intent).toBeUndefined();

		// Run is interactive, bound to the new plot, with the brainstorm agent.
		expect(body.run.mode).toBe("interactive");
		expect(body.run.agentName).toBe("brainstorm");
		expect(body.run.plotId).toBe("plot-brainstorm0");

		// A user_message event was appended on turn 0.
		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.mode).toBe("interactive");
		expect(persisted.trigger).toBe("brainstorm");
		const events = await repos.events.listByRunIds([body.run.id]);
		const userMsg = events.find((e) => e.kind === "user_message");
		expect(userMsg).toBeDefined();
		expect((userMsg?.payloadJson as { content: string }).content).toBe(
			"I want to ship a self-hostable warren tutorial",
		);
	});

	test("400 project_lacks_plot when the project has no .plot/ directory", async () => {
		// Replace the seeded hasPlot project with a non-hasPlot one.
		await db.close();
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "brainstorm",
			renderedJson: {
				name: "brainstorm",
				version: 1,
				sections: { system: "x" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
			hasPlot: false,
		});
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
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
		const res = await fetch(`${tcpUrl(handle)}/brainstorm`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id, prompt: "hello" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
	});

	test("400 when prompt is missing", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
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
		const res = await fetch(`${tcpUrl(handle)}/brainstorm`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id }),
		});
		expect(res.status).toBe(400);
	});

	test("custom name + agent are threaded through", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		await repos.agents.upsert({
			name: "brainstorm-custom",
			renderedJson: {
				name: "brainstorm-custom",
				version: 1,
				sections: { system: "x" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-brainstorm-ws-"));
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_bc", burrowRunId: "run_bc", workspacePath: tmpWs },
			[],
		);
		const created = {
			id: "plot-brainstorm9",
			name: "My Idea",
			status: "drafting" as const,
			intent_goal_preview: "",
			attachments_count: 0,
			last_event_ts: "2026-05-23T00:00:00Z",
			last_event_actor: "user:alice",
		};
		const plotCreator: import("../plots/index.ts").PlotCreator = {
			async create() {
				return created;
			},
		};
		const deps = await depsFor(repos, burrowClient);
		const depsWithCreator: ServerDeps = { ...deps, plotCreator };
		handle = startServer(depsWithCreator, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/brainstorm`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: project.id,
				prompt: "hello",
				name: "My Idea",
				agent: "brainstorm-custom",
				dispatcher_handle: "alice",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { agentName: string } };
		expect(body.run.agentName).toBe("brainstorm-custom");
	});
});

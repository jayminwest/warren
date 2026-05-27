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

/* Agents handlers (extracted from handlers.test.ts, warren-599c / pl-9088 step 3). */

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

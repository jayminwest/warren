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

/* Projects handlers (extracted from handlers.test.ts, warren-599c / pl-9088 step 3). */

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

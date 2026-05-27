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

/* POST /brainstorm tests (extracted from handlers.test.ts, warren-599c / pl-9088 step 3). */

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
		const plotCreator: import("../../plots/index.ts").PlotCreator = {
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
		const plotCreator: import("../../plots/index.ts").PlotCreator = {
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

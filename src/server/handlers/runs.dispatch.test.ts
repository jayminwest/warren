import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle } from "../types.ts";
import { depsFor, makeBurrowClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

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
				seedId: "seed-123",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string; seedId: string | null } };
		expect(body.run.seedId).toBe("seed-123");

		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.seedId).toBe("seed-123");
	});

	test("optional targetBranch persists onto runs.target_branch and pins the burrow branch (warren-709e)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-target-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_target000000", burrowRunId: "run_targetrun000", workspacePath: tmpWs },
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
				targetBranch: "fix/pr-head",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string; targetBranch: string | null } };
		expect(body.run.targetBranch).toBe("fix/pr-head");

		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.targetBranch).toBe("fix/pr-head");

		// targetBranch short-circuits the composed `${prefix}/${runId}` branch:
		// the burrow workspace branch equals the push target.
		const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
		expect((up?.body as { branch?: string } | undefined)?.branch).toBe("fix/pr-head");
	});

	test("continueFromRunId persists onto runs.parent_run_id (warren-4b11)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const parent = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "first pass",
			renderedAgentJson: { name: "refactor-bot", version: 1, sections: { system: "x" } },
			trigger: "manual",
		});

		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_cont00000000", burrowRunId: "run_contrun00000", workspacePath: "/tmp/ws" },
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
				prompt: "follow up",
				continueFromRunId: parent.id,
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string; parentRunId: string | null } };
		expect(body.run.parentRunId).toBe(parent.id);

		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.parentRunId).toBe(parent.id);
	});

	test("cloneFromRunId re-runs the parent's config with clone_kind=replicate (warren-e96f)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const parent = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "the original prompt",
			renderedAgentJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "x" },
				frontmatter: { provider: "anthropic", model: "claude-sonnet-4-6" },
			},
			trigger: "manual",
		});

		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_clone0000000", burrowRunId: "run_clonerun0000", workspacePath: "/tmp/ws" },
			[],
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		// One-click re-run: only cloneFromRunId is sent; agent/project/prompt
		// are inherited from the parent.
		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cloneFromRunId: parent.id }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			run: { id: string; parentRunId: string | null; cloneKind: string | null };
		};
		expect(body.run.parentRunId).toBe(parent.id);
		expect(body.run.cloneKind).toBe("replicate");

		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.agentName).toBe("refactor-bot");
		expect(persisted.prompt).toBe("the original prompt");
		expect(persisted.projectId).toBe(project.id);
		expect(persisted.cloneKind).toBe("replicate");
		// Effective model is replicated from the parent's frozen agent json.
		const fm = (persisted.renderedAgentJson as { frontmatter?: Record<string, unknown> })
			.frontmatter;
		expect(fm?.model).toBe("claude-sonnet-4-6");
	});

	test("invalid body params → 400 validation_error", async () => {
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
				plotId: "plot-deadbeef",
			}),
		});
		expect(res.status).toBe(201);
	});

	test("missing plot_id is treated as not supplied (no validation kicks in)", async () => {
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

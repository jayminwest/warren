import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle } from "../types.ts";
import {
	depsFor,
	makeRecordingLogger,
	makeSandboxClient,
	silentLogger,
	tcpUrl,
} from "./runs.test-helpers.ts";

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
		// step (real disk write into <ws>/.warren/agent.json) doesn't fail.
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_xxxxxxxxxxxx", sandboxRunId: "run_zzzzzzzzzzzz", workspacePath: tmpWs },
			calls,
		);

		// Stub bridge so the handler's deps.bridges.start() lands in our
		// registry without needing a real burrow stream.
		const bridgeStarted: { runId: string; sandboxRunId: string }[] = [];
		const bridges: BridgeRegistry = {
			start: (runId, sandboxRunId) => {
				bridgeStarted.push({ runId, sandboxRunId });
			},
			stopAll: async () => {},
			size: () => bridgeStarted.length,
		};
		const deps = await depsFor(repos, sandboxClient, bridges);

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
			sandbox: { id: string };
		};
		expect(body.run.id).toMatch(/^run_/);
		expect(body.run.state).toBe("queued");
		expect(body.sandbox.id).toBe("bur_xxxxxxxxxxxx");
		expect(bridgeStarted.length).toBe(1);
		expect(bridgeStarted[0]?.sandboxRunId).toBe("run_zzzzzzzzzzzz");
		expect(calls.some((c) => c.method === "POST" && c.path === "/sandboxes")).toBe(true);
		expect(calls.some((c) => c.path === "/sandboxes/bur_xxxxxxxxxxxx/runs")).toBe(true);
	});

	test("stamps dispatchOrigin=api on a plain POST /runs (warren-9ce3)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-origin-"));

		const { logger, lines } = makeRecordingLogger();
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_origin00000", sandboxRunId: "run_origin00000", workspacePath: tmpWs },
			[],
		);
		const deps = { ...(await depsFor(repos, sandboxClient)), logger };
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				dispatcherHandle: "@operator",
			}),
		});
		expect(res.status).toBe(201);

		const provisioned = lines.find((l) => l.obj.event === "spawn.provisioned");
		expect(provisioned?.obj.dispatch_origin).toBe("api");
		expect(provisioned?.obj.dispatcher_handle).toBe("@operator");
	});

	test("stamps dispatchOrigin=cli when body.trigger is cli (warren-9ce3)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-cli-"));

		const { logger, lines } = makeRecordingLogger();
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_cli00000000", sandboxRunId: "run_cli00000000", workspacePath: tmpWs },
			[],
		);
		const deps = { ...(await depsFor(repos, sandboxClient)), logger };
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				trigger: "cli",
			}),
		});
		expect(res.status).toBe(201);

		const provisioned = lines.find((l) => l.obj.event === "spawn.provisioned");
		expect(provisioned?.obj.dispatch_origin).toBe("cli");
	});

	test("optional seedId persists onto runs.seed_id (warren-805a)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-seedid-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_seed00000000", sandboxRunId: "run_seedrun00000", workspacePath: tmpWs },
			calls,
		);
		const deps = await depsFor(repos, sandboxClient);
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
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_target000000", sandboxRunId: "run_targetrun000", workspacePath: tmpWs },
			calls,
		);
		const deps = await depsFor(repos, sandboxClient);
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
		const up = calls.find((c) => c.method === "POST" && c.path === "/sandboxes");
		expect((up?.body as { branch?: string } | undefined)?.branch).toBe("fix/pr-head");
	});

	test("optional ref persists onto runs.ref and echoes in the POST /runs response (warren-afeb)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-ref-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_ref000000000", sandboxRunId: "run_refrun000000", workspacePath: tmpWs },
			calls,
		);
		const deps = await depsFor(repos, sandboxClient);
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
				prompt: "repair the PR",
				ref: "fix/pr-head",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string; ref: string | null } };
		expect(body.run.ref).toBe("fix/pr-head");

		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.ref).toBe("fix/pr-head");

		// A ref-less dispatch echoes null, not a dropped field.
		const res2 = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "ordinary run",
			}),
		});
		expect(res2.status).toBe(201);
		const body2 = (await res2.json()) as { run: { id: string; ref: string | null } };
		expect(body2.run.ref).toBeNull();
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
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_cont00000000", sandboxRunId: "run_contrun00000", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, sandboxClient);
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

		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_clone0000000", sandboxRunId: "run_clonerun0000", workspacePath: "/tmp/ws" },
			[],
		);
		const deps = await depsFor(repos, sandboxClient);
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
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_xxxxxxxxxxxx", sandboxRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, sandboxClient);
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

	test("non-object metadata → 400 validation_error, no burrow call (warren-b27c)", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_xxxxxxxxxxxx", sandboxRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		for (const metadata of [[1, 2], "nope", 7]) {
			const res = await fetch(`${tcpUrl(handle)}/runs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agent: "refactor-bot",
					project: project.id,
					prompt: "p",
					metadata,
				}),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("validation_error");
		}
		expect(calls).toEqual([]);
	});

	test("empty body → 400 validation_error", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_xxxxxxxxxxxx", sandboxRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, { method: "POST" });
		expect(res.status).toBe(400);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeBurrowClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

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

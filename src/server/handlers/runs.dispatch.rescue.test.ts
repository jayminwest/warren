import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * #1241 / warren-1db0: the `rescueFromRunId` dispatch field on `POST /runs` —
 * re-dispatch a salvaged run's recovered work off its `warren/rescue/<runId>`
 * branch. Split from runs.dispatch.test.ts so each describe stays under the
 * 500-line function budget. The spawn stub stands in for the remote: the
 * fail-closed ls-remote existence probe (warren-326f path) is answered there.
 */
describe("POST /runs — rescueFromRunId (#1241)", () => {
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
		// Real on-disk localPath so the project-refresh path inside POST /runs
		// (warren-1bb6) can pass its existsSync probe, mirroring the main
		// dispatch suite's setup.
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-rescue-proj-"));
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

	test("rescueFromRunId re-dispatches off the salvage rescue branch (#1241)", async () => {
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
		await repos.runs.setSalvage(parent.id, {
			rescueRef: `warren/rescue/${parent.id}`,
			bundlePath: null,
		});

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-rescue-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_rescue00000", sandboxRunId: "run_rescuerun000", workspacePath: tmpWs },
			calls,
		);
		// The fake forge stands in for the remote: the spawn stub answers the
		// fail-closed ls-remote existence probe for the rescue branch
		// (warren-326f path) while keeping the refresh probe no-op.
		const deps = {
			...(await depsFor(repos, sandboxClient)),
			spawn: async (cmd: readonly string[]) => {
				if (cmd.includes("ls-remote")) {
					return {
						stdout: `abc123\trefs/heads/warren/rescue/${parent.id}\n`,
						stderr: "",
						exitCode: 0,
					};
				}
				if (cmd[1] === "rev-parse") {
					return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		// One-click rescue: only rescueFromRunId is sent; agent/project/prompt
		// are inherited from the salvaged parent.
		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rescueFromRunId: parent.id }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			run: {
				id: string;
				parentRunId: string | null;
				cloneKind: string | null;
				agentName: string;
				prompt: string;
				ref: string | null;
				targetBranch: string | null;
			};
		};
		expect(body.run.parentRunId).toBe(parent.id);
		expect(body.run.cloneKind).toBe("rescue");
		expect(body.run.agentName).toBe("refactor-bot");
		expect(body.run.prompt).toBe("the original prompt");
		// The rescue branch is formalized as ref + targetBranch (the repair-run
		// pattern), so the workspace forks from it and reap pushes back to it.
		expect(body.run.ref).toBe(`warren/rescue/${parent.id}`);
		expect(body.run.targetBranch).toBe(`warren/rescue/${parent.id}`);

		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.projectId).toBe(project.id);
		expect(persisted.parentRunId).toBe(parent.id);
		expect(persisted.cloneKind).toBe("rescue");
		const up = calls.find((c) => c.method === "POST" && c.path === "/sandboxes");
		expect((up?.body as { branch?: string }).branch).toBe(`warren/rescue/${parent.id}`);
	});

	test("rescueFromRunId refuses a run with no salvage rescue branch (#1241)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const parent = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "never salvaged",
			renderedAgentJson: { name: "refactor-bot", version: 1, sections: { system: "x" } },
			trigger: "manual",
		});

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_nosalvage00", sandboxRunId: "run_nosalvage000", workspacePath: "/tmp/ws" },
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
			body: JSON.stringify({ rescueFromRunId: parent.id }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toMatch(/no rescue branch/);
		// No side effects: no provider contact.
		expect(calls).toEqual([]);
	});

	test("rescueFromRunId refuses combination with continueFromRunId and existingBranch (#1241)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const parent = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "the original prompt",
			renderedAgentJson: { name: "refactor-bot", version: 1, sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.setSalvage(parent.id, {
			rescueRef: `warren/rescue/${parent.id}`,
			bundlePath: null,
		});

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_rescux00000", sandboxRunId: "run_rescuxrun000", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		for (const extra of [
			{ continueFromRunId: parent.id },
			{ cloneFromRunId: parent.id },
			{ existingBranch: `warren/rescue/${parent.id}` },
		]) {
			const res = await fetch(`${tcpUrl(handle)}/runs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ rescueFromRunId: parent.id, ...extra }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.code).toBe("validation_error");
			expect(body.error.message).toMatch(/rescueFromRunId cannot be combined with/);
		}
		// No side effects: no provider contact.
		expect(calls).toEqual([]);
	});
});

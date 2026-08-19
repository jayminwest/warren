import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * warren-aaf7: the baseCommit / ref split at the HTTP boundary. `ref` must
 * stay branch-shaped (a 40-hex value is a 400 pointing at `baseCommit`);
 * `baseCommit` must be exactly 40 hex. A valid pin persists onto
 * `runs.base_commit` and echoes in the POST /runs response.
 */
describe("POST /runs — baseCommit boundary validation (warren-aaf7)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

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
		const projectLocalPath = await mkdtemp(join(tmpdir(), "warren-handlers-base-proj-"));

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

	test("baseCommit persists + echoes; a SHA in ref and a malformed baseCommit are 400s", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-base-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_base00000000", sandboxRunId: "run_baserun00000", workspacePath: tmpWs },
			calls,
		);
		const bridges: BridgeRegistry = {
			start: () => {},
			stopAll: async () => {},
			size: () => 0,
		};
		const deps = await depsFor(repos, sandboxClient, bridges);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const sha = "0123456789abcdef0123456789abcdef01234567";
		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "replay history",
				baseCommit: sha,
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string; baseCommit: string | null } };
		expect(body.run.baseCommit).toBe(sha);
		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.baseCommit).toBe(sha);
		expect(persisted.ref).toBeNull();

		// A 40-hex value in `ref` is rejected with a pointer to baseCommit.
		const shaRef = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "replay history",
				ref: sha,
			}),
		});
		expect(shaRef.status).toBe(400);
		const shaRefBody = (await shaRef.json()) as { error?: { hint?: string } };
		expect(shaRefBody.error?.hint ?? "").toContain("baseCommit");

		// A malformed baseCommit (short id / branch name) is rejected.
		for (const bad of ["abc123", "main"]) {
			const badRes = await fetch(`${tcpUrl(handle)}/runs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agent: "refactor-bot",
					project: project.id,
					prompt: "replay history",
					baseCommit: bad,
				}),
			});
			expect(badRes.status).toBe(400);
		}

		// A malformed branch in `ref` is likewise rejected.
		const badRef = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "replay history",
				ref: "bad..branch",
			}),
		});
		expect(badRef.status).toBe(400);
	});

	test("a well-formed branch ref still dispatches unchanged (regression bar)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-branch-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_brn000000000", sandboxRunId: "run_branchrun0000", workspacePath: tmpWs },
			calls,
		);
		const bridges: BridgeRegistry = {
			start: () => {},
			stopAll: async () => {},
			size: () => 0,
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
				prompt: "repair the PR",
				ref: "fix/pr-head",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			run: { id: string; ref: string | null; baseCommit: string | null };
		};
		expect(body.run.ref).toBe("fix/pr-head");
		expect(body.run.baseCommit).toBeNull();
	});
});

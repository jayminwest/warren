import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { GitHubForge } from "../../forge/github/provider.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./projects.test-helpers.ts";

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
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
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
		const sandboxClient = new FakeProvider();
		const seenRefs: string[] = [];
		const deps: ServerDeps = {
			...(await depsFor(repos, sandboxClient)),
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
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
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

	// warren-6c4c: the refresh handler mints the fetch credential per-spawn
	// through the boot forge (forge-contract.md §4) — the secret reaches git
	// only as per-spawn GIT_CONFIG_* env, never held on a config object.
	test("mints the fetch credential through the boot forge into the per-spawn env", async () => {
		const sandboxClient = new FakeProvider();
		const spawnEnvs: (Record<string, string | undefined> | undefined)[] = [];
		const deps: ServerDeps = {
			...(await depsFor(repos, sandboxClient)),
			forge: new GitHubForge({ token: "minted-secret" }),
			spawn: async (cmd, opts) => {
				spawnEnvs.push(opts.env);
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/refresh`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const credEnvs = spawnEnvs.filter((env) => env?.GIT_CONFIG_KEY_0 !== undefined);
		expect(credEnvs.length).toBeGreaterThan(0);
		for (const env of credEnvs) {
			expect(env?.GIT_CONFIG_KEY_0).toContain("x-access-token:minted-secret");
		}
	});

	test("a forge that does not own the clone URL spawns anonymous git", async () => {
		const sandboxClient = new FakeProvider();
		// depsFor wires FakeForge, which owns only fake:// URLs — the github.com
		// project above parses to null, so no credential is minted.
		const spawnEnvs: (Record<string, string | undefined> | undefined)[] = [];
		const deps: ServerDeps = {
			...(await depsFor(repos, sandboxClient)),
			spawn: async (cmd, opts) => {
				spawnEnvs.push(opts.env);
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/refresh`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		for (const env of spawnEnvs) {
			expect(env?.GIT_CONFIG_KEY_0).toBeUndefined();
		}
	});
});

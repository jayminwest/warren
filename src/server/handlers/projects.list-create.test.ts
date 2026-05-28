import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./projects.test-helpers.ts";

describe("GET /projects", () => {
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

	test("returns empty projects initially", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: unknown[] };
		expect(body.projects).toEqual([]);
	});

	test("returns list of projects when populated", async () => {
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

		const row = await repos.projects.create({
			gitUrl: "https://github.com/foo/bar.git",
			localPath: "/tmp/foo-bar",
			defaultBranch: "main",
		});

		const res = await fetch(`${tcpUrl(handle)}/projects`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: { id: string; gitUrl: string }[] };
		expect(body.projects.length).toBe(1);
		expect(body.projects[0]?.id).toBe(row.id);
		expect(body.projects[0]?.gitUrl).toBe("https://github.com/foo/bar.git");
	});
});

describe("POST /projects validation", () => {
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

	test("returns 400 when body is empty or missing gitUrl", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when gitUrl is invalid format", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ gitUrl: "not-a-valid-git-url" }),
		});
		expect(res.status).toBe(400);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./projects.test-helpers.ts";

describe("DELETE /projects/:id", () => {
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

	test("deletes an existing project and returns 200", async () => {
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

		// Create project under the projects config root (e.g., /tmp/projects)
		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/tmp/projects/del-proj",
			defaultBranch: "main",
		});

		// Delete project
		const resDelete = await fetch(`${tcpUrl(handle)}/projects/${row.id}`, {
			method: "DELETE",
		});
		expect(resDelete.status).toBe(200);
		const body = (await resDelete.json()) as { id: string };
		expect(body.id).toBe(row.id);

		// Verify deleted from repo
		const found = await repos.projects.get(row.id);
		expect(found).toBeNull();
	});

	test("returns 404 when deleting a non-existent project", async () => {
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

		const resDelete = await fetch(`${tcpUrl(handle)}/projects/prj_not_exist`, {
			method: "DELETE",
		});
		expect(resDelete.status).toBe(404);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WarrenClient } from "../../client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, NO_AUTH, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./projects.test-helpers.ts";
import { PUBLIC_PROJECT_FIELDS } from "./projects.ts";

/** A burrow client no assertion here reaches. */
function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
}

describe("GET /projects/:id (warren-2a89)", () => {
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

	test("returns the full row for an operator", async () => {
		const deps = await depsFor(repos, inertSandboxClient());
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${row.id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe(row.id);
		expect(body.gitUrl).toBe("https://github.com/foo/bar.git");
		expect(body.localPath).toBe("/tmp/foo-bar");
	});

	test("returns the canonical 404 envelope for an unknown id", async () => {
		const deps = await depsFor(repos, inertSandboxClient());
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/warren-nope`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("the SDK getProject round-trips against the real route", async () => {
		const deps = await depsFor(repos, inertSandboxClient());
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

		const client = new WarrenClient({ config: { baseUrl: tcpUrl(handle) } });
		const project = await client.getProject(row.id);
		expect(project.id).toBe(row.id);
		expect(project.gitUrl).toBe("https://github.com/foo/bar.git");
	});

	test("an anonymous spectator sees only the public field set", async () => {
		const deps = await depsFor(repos, inertSandboxClient());
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth("s3cret")),
			logger: silentLogger,
		});
		const row = await repos.projects.create({
			gitUrl: "https://github.com/foo/bar.git",
			localPath: "/tmp/foo-bar",
			defaultBranch: "main",
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${row.id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual([...PUBLIC_PROJECT_FIELDS].sort());
		expect(JSON.stringify(body)).not.toContain("/tmp/foo-bar");
	});
});

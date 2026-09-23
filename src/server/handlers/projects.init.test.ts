import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { parseConfigFile, parseTriggersConfig } from "../../warren-config/schema.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./projects.test-helpers.ts";

/**
 * `POST /projects/:id/init` + `POST /projects/:id/config-migrate`
 * (warren-166d): the server-side `.warren/` writes that let a remote CLI
 * scaffold / migrate a project whose clone lives on the warren host.
 * Modelled on `projects.refresh.test.ts`.
 */

describe("POST /projects/:id/init", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-init-proj-"));

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
		await rm(projectLocalPath, { recursive: true, force: true });
	});

	async function start(): Promise<string> {
		const sandboxClient = new FakeProvider();
		const deps: ServerDeps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	test("scaffolds triggers.yaml + config.yaml into the host clone, returns 201", async () => {
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			projectId: string;
			scaffolded: { files: string[]; defaultRole: string | null };
		};
		expect(body.projectId).toBe(projectId);
		expect(body.scaffolded.files).toEqual([".warren/triggers.yaml", ".warren/config.yaml"]);
		expect(body.scaffolded.defaultRole).toBeNull();

		const triggersRaw = await readFile(join(projectLocalPath, ".warren/triggers.yaml"), "utf8");
		expect(parseTriggersConfig(load(triggersRaw)).ok).toBe(true);
		const configRaw = await readFile(join(projectLocalPath, ".warren/config.yaml"), "utf8");
		const parsed = parseConfigFile(load(configRaw));
		expect(parsed.ok).toBe(true);
	});

	test("forwards the defaults fields into config.yaml", async () => {
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ defaultRole: "claude-code", runBranchPrefix: "warren" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { scaffolded: { defaultRole: string | null } };
		expect(body.scaffolded.defaultRole).toBe("claude-code");

		const configRaw = await readFile(join(projectLocalPath, ".warren/config.yaml"), "utf8");
		expect(load(configRaw)).toEqual({ defaultRole: "claude-code", runBranchPrefix: "warren" });
	});

	test("refuses to overwrite an existing triggers.yaml with 400", async () => {
		await mkdir(join(projectLocalPath, ".warren"), { recursive: true });
		await writeFile(join(projectLocalPath, ".warren/triggers.yaml"), "[]\n");
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("refusing to overwrite");
	});

	test("overwrite: true bypasses the refusal and rewrites both files", async () => {
		await mkdir(join(projectLocalPath, ".warren"), { recursive: true });
		await writeFile(join(projectLocalPath, ".warren/triggers.yaml"), "[]\n");
		await writeFile(join(projectLocalPath, ".warren/config.yaml"), "defaultRole: stale\n");
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ defaultRole: "pi", overwrite: true }),
		});
		expect(res.status).toBe(201);
		const configRaw = await readFile(join(projectLocalPath, ".warren/config.yaml"), "utf8");
		expect(load(configRaw)).toEqual({ defaultRole: "pi" });
	});

	test("accepts an empty request body", async () => {
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/init`, { method: "POST" });
		expect(res.status).toBe(201);
		expect(existsSync(join(projectLocalPath, ".warren/config.yaml"))).toBe(true);
	});

	test("returns 400 for a schema-invalid defaults field", async () => {
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ runBranchPrefix: "Not A Prefix" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("config.yaml failed schema validation");
	});

	test("returns 400 for a non-string defaults field", async () => {
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ defaultRole: 42 }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 404 for an unknown project id", async () => {
		const base = await start();
		const res = await fetch(`${base}/projects/prj_doesnotexist/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	test("returns 400 when the clone is missing on disk", async () => {
		const missing = join(projectLocalPath, "vanished");
		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: missing,
			defaultBranch: "main",
		});
		const base = await start();
		const res = await fetch(`${base}/projects/${row.id}/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("project clone missing on disk");
	});
});

describe("POST /projects/:id/config-migrate", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-migrate-proj-"));

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
		await rm(projectLocalPath, { recursive: true, force: true });
	});

	async function start(): Promise<string> {
		const sandboxClient = new FakeProvider();
		const deps: ServerDeps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	test("converts defaults.json in the host clone and returns 200", async () => {
		await mkdir(join(projectLocalPath, ".warren"), { recursive: true });
		await writeFile(
			join(projectLocalPath, ".warren/defaults.json"),
			JSON.stringify({ defaultRole: "claude-code", defaultBranch: "main" }),
		);
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/config-migrate`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			projectId: string;
			migrated: { written: string[]; previewHoisted: boolean };
		};
		expect(body.projectId).toBe(projectId);
		expect(body.migrated.written).toEqual([".warren/config.yaml"]);
		expect(body.migrated.previewHoisted).toBe(false);

		expect(existsSync(join(projectLocalPath, ".warren/defaults.json"))).toBe(false);
		const configRaw = await readFile(join(projectLocalPath, ".warren/config.yaml"), "utf8");
		expect(load(configRaw)).toEqual({ defaultRole: "claude-code", defaultBranch: "main" });
	});

	test("hoists a preview block into preview.yaml", async () => {
		await mkdir(join(projectLocalPath, ".warren"), { recursive: true });
		await writeFile(
			join(projectLocalPath, ".warren/defaults.json"),
			JSON.stringify({
				defaultRole: "claude-code",
				preview: { type: "server", command: "bun run dev", port: 3000, readiness_path: "/healthz" },
			}),
		);
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/config-migrate`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { migrated: { previewHoisted: boolean } };
		expect(body.migrated.previewHoisted).toBe(true);
		const previewRaw = await readFile(join(projectLocalPath, ".warren/preview.yaml"), "utf8");
		expect(load(previewRaw)).toEqual({
			type: "server",
			command: "bun run dev",
			port: 3000,
			readiness_path: "/healthz",
		});
	});

	test("returns 400 when there is nothing to migrate", async () => {
		const base = await start();
		const res = await fetch(`${base}/projects/${projectId}/config-migrate`, {
			method: "POST",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("nothing to migrate");
	});

	test("returns 404 for an unknown project id", async () => {
		const base = await start();
		const res = await fetch(`${base}/projects/prj_doesnotexist/config-migrate`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
	});
});

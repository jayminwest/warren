import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./projects.test-helpers.ts";

describe("GET /projects/:id/warren-config — per-project .warren/ envelope (warren-435b)", () => {
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
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-wcfg-proj-"));

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

	test("returns null fields + empty errors when .warren/ is absent", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/warren-config`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: unknown;
			defaults: unknown;
			sourceFile: unknown;
			errors: unknown[];
		};
		expect(body.triggers).toBeNull();
		expect(body.defaults).toBeNull();
		expect(body.sourceFile).toBeNull();
		expect(body.errors).toEqual([]);
	});

	test("returns parsed triggers + defaults when both files are valid", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  seed: warren-1\n  role: refactor-bot\n",
		);
		await writeFile(
			join(projectLocalPath, ".warren", "defaults.json"),
			JSON.stringify({ defaultBranch: "main", defaultRole: "refactor-bot" }),
		);

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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/warren-config`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: { id: string; kind: string; cron: string }[] | null;
			defaults: { defaultBranch?: string; defaultRole?: string } | null;
			sourceFile: string | null;
			errors: unknown[];
		};
		expect(body.errors).toEqual([]);
		expect(body.triggers?.[0]?.id).toBe("nightly");
		expect(body.triggers?.[0]?.cron).toBe("0 2 * * *");
		expect(body.defaults?.defaultBranch).toBe("main");
		expect(body.defaults?.defaultRole).toBe("refactor-bot");
		// only legacy defaults.json present → sourceFile points at it
		expect(body.sourceFile).toBe(".warren/defaults.json");
	});

	test("collects per-file errors when a file is malformed", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		// Schema violation: missing required `seed` and `role`.
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n",
		);
		// JSON parse error.
		await writeFile(join(projectLocalPath, ".warren", "defaults.json"), "{not-json");

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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/warren-config`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: unknown;
			defaults: unknown;
			errors: { file: string; code: string; message: string }[];
		};
		expect(body.triggers).toBeNull();
		expect(body.defaults).toBeNull();
		expect(body.errors.length).toBe(2);
		const triggersErr = body.errors.find((e) => e.file === ".warren/triggers.yaml");
		const defaultsErr = body.errors.find((e) => e.file === ".warren/defaults.json");
		expect(triggersErr?.code).toBe("warren_config_schema_error");
		expect(defaultsErr?.code).toBe("warren_config_parse_error");
	});

	test("returns 404 for an unknown project id", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/warren-config`);
		expect(res.status).toBe(404);
	});

	test("returns 503 when the project clone is missing on disk", async () => {
		const { rm } = await import("node:fs/promises");
		await rm(projectLocalPath, { recursive: true, force: true });

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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/warren-config`);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("warren_config_unavailable");
	});
});

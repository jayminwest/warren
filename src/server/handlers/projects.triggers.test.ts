import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./projects.test-helpers.ts";

describe("GET /projects/:id/triggers — parsed YAML joined with scheduler state (warren-99c3)", () => {
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
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-triggers-get-"));

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

	test("empty list + empty errors when .warren/ is absent", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { triggers: unknown[]; errors: unknown[] };
		expect(body.triggers).toEqual([]);
		expect(body.errors).toEqual([]);
	});

	test("joins parsed YAML with persisted last/next/lastRunId and freshly-computed nextFireAt", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  seed: warren-1\n  role: refactor-bot\n",
		);

		// Seed an agent + run so the scheduler row's lastRunId FK resolves.
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const seedRun = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: { name: "refactor-bot", sections: { system: "..." } },
			trigger: "cron",
		});

		// Pre-populate the scheduler row so the join surfaces lastFiredAt +
		// lastRunId. Persisted nextFireAt is intentionally stale so the
		// freshly-computed value beats it on the wire.
		await repos.triggers.upsert({
			projectId,
			triggerId: "nightly",
			lastFiredAt: "2026-05-09T02:00:00.000Z",
			nextFireAt: "2026-05-10T02:00:00.000Z",
			lastRunId: seedRun.id,
		});

		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps: ServerDeps = {
			...(await depsFor(repos, burrowClient)),
			// Freeze "now" so the recomputed nextFireAt is deterministic.
			now: () => new Date("2026-05-10T12:00:00.000Z"),
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: {
				id: string;
				kind: string;
				cron: string;
				seed: string;
				role: string;
				lastFiredAt: string | null;
				nextFireAt: string | null;
				lastRunId: string | null;
				parseError: string | null;
			}[];
			errors: unknown[];
		};
		expect(body.errors).toEqual([]);
		expect(body.triggers.length).toBe(1);
		const t = body.triggers[0];
		expect(t?.id).toBe("nightly");
		expect(t?.cron).toBe("0 2 * * *");
		expect(t?.seed).toBe("warren-1");
		expect(t?.role).toBe("refactor-bot");
		expect(t?.lastFiredAt).toBe("2026-05-09T02:00:00.000Z");
		expect(t?.lastRunId).toBe(seedRun.id);
		// Next fire is 2026-05-11T02:00:00Z (next 02:00 UTC after frozen now).
		expect(t?.nextFireAt).toBe("2026-05-11T02:00:00.000Z");
		expect(t?.parseError).toBeNull();
	});

	test("surfaces YAML schema errors in the errors envelope", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		// Schema violation: missing required `seed` and `role`.
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n",
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

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			triggers: unknown[];
			errors: { file: string; code: string }[];
		};
		expect(body.triggers).toEqual([]);
		expect(body.errors.length).toBe(1);
		expect(body.errors[0]?.file).toBe(".warren/triggers.yaml");
		expect(body.errors[0]?.code).toBe("warren_config_schema_error");
	});

	test("404 for an unknown project id", async () => {
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

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/triggers`);
		expect(res.status).toBe(404);
	});
});

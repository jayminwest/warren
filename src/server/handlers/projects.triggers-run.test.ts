import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, makeBurrowClient, silentLogger, tcpUrl } from "./projects.test-helpers.ts";

describe("POST /projects/:id/triggers/:triggerId/run — manual Run Now (warren-99c3)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let projectId = "";

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

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-triggers-run-"));

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

	test("dispatches the named trigger, returns 201, records fire + bridge", async () => {
		const { mkdir, writeFile, mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  seed: warren-1\n  role: refactor-bot\n  prompt: 'hand-rolled prompt'\n",
		);

		const tmpWs = await mkdtemp(join(tmpdir(), "warren-triggers-ws-"));
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: tmpWs },
			calls,
		);

		const bridgeStarted: { runId: string; burrowRunId: string }[] = [];
		const bridges: BridgeRegistry = {
			start: (runId, burrowRunId) => {
				bridgeStarted.push({ runId, burrowRunId });
			},
			stopAll: async () => {},
			size: () => bridgeStarted.length,
		};
		const deps: ServerDeps = {
			...(await depsFor(repos, burrowClient, bridges)),
			now: () => new Date("2026-05-10T12:00:00.000Z"),
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers/nightly/run`, {
			method: "POST",
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			run: { id: string; trigger: string; agentName: string; prompt: string };
			burrow: { id: string; workspacePath: string };
		};
		expect(body.run.id).toMatch(/^run_/);
		expect(body.run.trigger).toBe("manual-trigger");
		expect(body.run.agentName).toBe("refactor-bot");
		expect(body.run.prompt).toBe("hand-rolled prompt");
		expect(body.burrow.id).toBe("bur_xxxxxxxxxxxx");
		expect(bridgeStarted.length).toBe(1);
		expect(bridgeStarted[0]?.burrowRunId).toBe("run_zzzzzzzzzzzz");

		// Triggers row stamped with manual fire + nextFireAt rolled forward.
		const row = await repos.triggers.get({ projectId, triggerId: "nightly" });
		expect(row?.lastFiredAt).toBe("2026-05-10T12:00:00.000Z");
		expect(row?.nextFireAt).toBe("2026-05-11T02:00:00.000Z");
		expect(row?.lastRunId).toBe(body.run.id);
	});

	test("404 when the trigger id is not in .warren/triggers.yaml", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await mkdir(join(projectLocalPath, ".warren"));
		await writeFile(
			join(projectLocalPath, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  seed: warren-1\n  role: refactor-bot\n",
		);

		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/triggers/missing/run`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("404 when the project id is unknown", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/triggers/nightly/run`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
	});
});

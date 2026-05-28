import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSdSpawn, silentLogger, tcpUrl } from "./plan-runs.test-helpers.ts";

describe("GET /plan-runs", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let seedyProjectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const seedy = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy",
			defaultBranch: "main",
			hasSeeds: true,
		});
		seedyProjectId = seedy.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("returns active plan_runs when no filter is set", async () => {
		await repos.planRuns.create({
			planId: "pl-active",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		const done = await repos.planRuns.create({
			planId: "pl-done",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-b" }],
		});
		// Drive the second through to running → succeeded so listActive omits it.
		await repos.planRuns.transitionTo(done.planRun.id, "running", {
			startedAt: new Date().toISOString(),
		});
		await repos.planRuns.transitionTo(done.planRun.id, "succeeded", {
			endedAt: new Date().toISOString(),
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { planRuns: { planId: string }[] };
		expect(body.planRuns.map((p) => p.planId)).toEqual(["pl-active"]);
	});

	test("filters by project + state", async () => {
		await repos.planRuns.create({
			planId: "pl-q",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs?project=${seedyProjectId}&state=queued`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { planRuns: { planId: string; state: string }[] };
		expect(body.planRuns).toHaveLength(1);
		expect(body.planRuns[0]?.state).toBe("queued");
	});
});

describe("GET /plan-runs/:id", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let seedyProjectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const seedy = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy",
			defaultBranch: "main",
			hasSeeds: true,
		});
		seedyProjectId = seedy.id;
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "you are claude" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("returns plan_run + children + fanned-out runs[]", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-detail",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [
				{ seq: 1, seedId: "wa-a" },
				{ seq: 2, seedId: "wa-b" },
			],
		});

		const runA = await repos.runs.create({
			agentName: "claude-code",
			projectId: seedyProjectId,
			prompt: "work on sd wa-a",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: { runId: runA.id, state: "dispatched", startedAt: new Date().toISOString() },
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			planRun: { id: string };
			children: { seq: number; runId: string | null }[];
			runs: { id: string }[];
		};
		expect(body.planRun.id).toBe(created.planRun.id);
		expect(body.children).toHaveLength(2);
		expect(body.runs.map((r) => r.id)).toEqual([runA.id]);
	});

	test("404 for unknown id", async () => {
		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs/planRun_nope`);
		expect(res.status).toBe(404);
	});
});

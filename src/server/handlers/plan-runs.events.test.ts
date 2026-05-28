import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSdSpawn, silentLogger, tcpUrl } from "./plan-runs.test-helpers.ts";

describe("GET /plan-runs/:id/events", () => {
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

	test("snapshots persisted events from every child run (no follow)", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-events",
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
		const runB = await repos.runs.create({
			agentName: "claude-code",
			projectId: seedyProjectId,
			prompt: "work on sd wa-b",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: { runId: runA.id },
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 2,
			patch: { runId: runB.id },
		});

		await repos.events.append({
			runId: runA.id,
			burrowEventSeq: 1,
			ts: "2026-05-18T00:00:00.000Z",
			kind: "plan_run.dispatched",
			stream: "system",
			payload: { seq: 1 },
		});
		await repos.events.append({
			runId: runB.id,
			burrowEventSeq: 1,
			ts: "2026-05-18T00:00:01.000Z",
			kind: "plan_run.dispatched",
			stream: "system",
			payload: { seq: 2 },
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/events`);
		expect(res.status).toBe(200);
		const text = await res.text();
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l) as { kind: string; runId: string });
		expect(parsed.map((p) => p.runId).sort()).toEqual([runA.id, runB.id].sort());
		expect(parsed.every((p) => p.kind === "plan_run.dispatched")).toBe(true);
	});

	test("404 for unknown plan_run id", async () => {
		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs/planRun_nope/events`);
		expect(res.status).toBe(404);
	});
});

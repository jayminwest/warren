import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSdSpawn, silentLogger, tcpUrl } from "./plan-runs.test-helpers.ts";

describe("POST /plan-runs/:id/cancel", () => {
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

	test("cancels an in-flight child via cancelRun + flips plan_run to cancelled", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-cancel",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running", {
			startedAt: new Date().toISOString(),
		});

		// Create a queued run with NO burrow_run_id — cancelRun's "partial spawn"
		// branch handles this without a burrow round-trip, so we can assert the
		// chain through without stubbing the burrow client's cancel endpoint.
		const childRun = await repos.runs.create({
			agentName: "claude-code",
			projectId: seedyProjectId,
			prompt: "work on sd wa-a",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: { runId: childRun.id, state: "dispatched", startedAt: new Date().toISOString() },
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/cancel`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			planRun: { state: string };
			cancelledChild: { childSeq: number; runId: string } | null;
			alreadyTerminal: boolean;
		};
		expect(body.planRun.state).toBe("cancelled");
		expect(body.cancelledChild).toEqual({ childSeq: 1, runId: childRun.id });
		expect(body.alreadyTerminal).toBe(false);

		const persistedChild = await repos.runs.require(childRun.id);
		expect(persistedChild.state).toBe("cancelled");
	});

	test("alreadyTerminal=true for a plan_run already in cancelled/succeeded/failed", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-terminal",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "cancelled", {
			endedAt: new Date().toISOString(),
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/cancel`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { alreadyTerminal: boolean; cancelledChild: unknown };
		expect(body.alreadyTerminal).toBe(true);
		expect(body.cancelledChild).toBeNull();
	});
});

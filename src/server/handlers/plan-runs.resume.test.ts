import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSdSpawn, silentLogger, tcpUrl } from "./plan-runs.test-helpers.ts";

describe("POST /plan-runs/:id/resume (warren-1eff)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy",
			defaultBranch: "main",
			hasSeeds: true,
		});
		projectId = project.id;
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

	async function serve(): Promise<string> {
		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	async function failPlanRunWithChildMergeTimeout(): Promise<string> {
		const created = await repos.planRuns.create({
			planId: "pl-resume",
			projectId,
			agentName: "claude-code",
			children: [
				{ seq: 1, seedId: "wa-a" },
				{ seq: 2, seedId: "wa-b" },
			],
		});
		const childRun = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "work on sd wa-a",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.runs.markRunning(childRun.id, new Date());
		await repos.runs.finalize(childRun.id, "succeeded", new Date());
		await repos.runs.setPrUrl(childRun.id, "https://github.com/x/seedy/pull/12");
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: { runId: childRun.id, state: "dispatched", startedAt: new Date().toISOString() },
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: {
				state: "failed",
				failureReason: "child_pr_merge_timeout",
				endedAt: new Date().toISOString(),
			},
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running", {
			startedAt: new Date().toISOString(),
		});
		await repos.planRuns.transitionTo(created.planRun.id, "failed", {
			failureReason: "child_pr_merge_timeout",
			endedAt: new Date().toISOString(),
		});
		return created.planRun.id;
	}

	test("resumes a child-merge-timeout plan-run: 200, running, child back to pr_open", async () => {
		const planRunId = await failPlanRunWithChildMergeTimeout();
		const base = await serve();
		const res = await fetch(`${base}/plan-runs/${planRunId}/resume`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			planRun: { state: string; failureReason: string | null };
			reason: string;
			resumedChild: { seq: number; runId: string | null } | null;
		};
		expect(body.planRun.state).toBe("running");
		expect(body.planRun.failureReason).toBeNull();
		expect(body.reason).toBe("child_pr_merge_timeout");
		expect(body.resumedChild?.seq).toBe(1);

		const children = await repos.planRuns.listChildren(planRunId);
		expect(children.find((c) => c.seq === 1)?.state).toBe("pr_open");
		// The resumed row is active again, so the coordinator picks it up.
		const active = await repos.planRuns.listActive();
		expect(active.map((r) => r.id)).toContain(planRunId);
	});

	test("409 on a plan-run that is not failed", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-running",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		const base = await serve();
		const res = await fetch(`${base}/plan-runs/${created.planRun.id}/resume`, { method: "POST" });
		expect(res.status).toBe(409);
		const reloaded = await repos.planRuns.require(created.planRun.id);
		expect(reloaded.state).toBe("queued");
	});

	test("409 on a non-merge-timeout failure, no state change", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-dispatch-failed",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running", {
			startedAt: new Date().toISOString(),
		});
		await repos.planRuns.transitionTo(created.planRun.id, "failed", {
			failureReason: "dispatch_failed:boom",
			endedAt: new Date().toISOString(),
		});
		const base = await serve();
		const res = await fetch(`${base}/plan-runs/${created.planRun.id}/resume`, { method: "POST" });
		expect(res.status).toBe(409);
		const reloaded = await repos.planRuns.require(created.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("dispatch_failed:boom");
	});

	test("404 on an unknown plan-run id", async () => {
		const base = await serve();
		const res = await fetch(`${base}/plan-runs/plnr_nope/resume`, { method: "POST" });
		expect(res.status).toBe(404);
	});
});

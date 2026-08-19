import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_PLAN_RUN_PROMPT_TEMPLATE } from "../../core/plan-run-prompt.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	depsFor,
	makeSdSpawn,
	planShowResult,
	type SdCall,
	seedShowResult,
	setupPlanRunFixture,
	silentLogger,
	tcpUrl,
} from "./plan-runs.test-helpers.ts";

describe("POST /plan-runs", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";
	let seedyProjectId = "";

	beforeEach(async () => {
		const f = await setupPlanRunFixture();
		db = f.db;
		repos = f.repos;
		projectId = f.projectId;
		seedyProjectId = f.seedyProjectId;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("happy path: persists plan_run + children, returns 201", async () => {
		const calls: SdCall[] = [];
		const sdSpawn = makeSdSpawn(calls, [
			{
				match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
				result: planShowResult("pl-acc", "active", ["wa-a", "wa-b", "wa-c"]),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
				result: seedShowResult("wa-a", "open"),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-b",
				result: seedShowResult("wa-b", "open"),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-c",
				result: seedShowResult("wa-c", "closed"),
			},
		]);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				planId: "pl-acc",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			planRun: { id: string; planId: string; agentName: string; state: string };
			children: { seq: number; seedId: string; state: string }[];
		};
		expect(body.planRun.planId).toBe("pl-acc");
		expect(body.planRun.agentName).toBe("claude-code");
		expect(body.planRun.state).toBe("queued");
		expect(body.children.map((c) => ({ seq: c.seq, seedId: c.seedId, state: c.state }))).toEqual([
			{ seq: 1, seedId: "wa-a", state: "pending" },
			{ seq: 2, seedId: "wa-b", state: "pending" },
			{ seq: 3, seedId: "wa-c", state: "pending" },
		]);

		// Persisted shape — pickNextPending returns the first open child.
		const next = await repos.planRuns.pickNextPending(body.planRun.id);
		expect(next?.seedId).toBe("wa-a");
	});

	test("issues form (warren-de42): ordered issue-id list drives the same walk, no plan read", async () => {
		const calls: SdCall[] = [];
		const sdSpawn = makeSdSpawn(calls, [
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
				result: seedShowResult("wa-a", "open"),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-b",
				result: seedShowResult("wa-b", "open"),
			},
		]);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				issues: ["wa-a", "wa-b"],
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			planRun: { id: string; planId: string | null; source: string; state: string };
			children: { seq: number; seedId: string }[];
		};
		expect(body.planRun.planId).toBeNull();
		expect(body.planRun.source).toBe("issues");
		expect(body.children.map((c) => ({ seq: c.seq, seedId: c.seedId }))).toEqual([
			{ seq: 1, seedId: "wa-a" },
			{ seq: 2, seedId: "wa-b" },
		]);
		// The plan form's `sd plan show` never fired — the list form skips getPlan.
		expect(calls.some((c) => c.cmd[1] === "plan")).toBe(false);
	});

	test("rejects a body with both planId and issues: 400", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				planId: "pl-acc",
				issues: ["wa-a"],
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("rejects projects without .seeds/: 400 + code=project_lacks_seeds", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: projectId,
				planId: "pl-x",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_seeds");
	});

	test("rejects plans whose children are all closed: 400 + code=plan_has_no_open_children", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-shut", "active", ["wa-a", "wa-b"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "closed"),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-b",
					result: seedShowResult("wa-b", "closed"),
				},
			],
		);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				planId: "pl-shut",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("plan_has_no_open_children");
	});

	test("refreshes the project clone before walking the plan (warren-6d60)", async () => {
		const order: string[] = [];
		const calls: SdCall[] = [];
		const sdSpawn = makeSdSpawn(calls, [
			{
				match: (cmd) => {
					order.push("plan-show");
					return cmd[1] === "plan" && cmd[2] === "show";
				},
				result: planShowResult("pl-fresh", "active", ["wa-a"]),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
				result: seedShowResult("wa-a", "open"),
			},
		]);
		const refreshedIds: string[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			// Wire the git spawn seam so the handler attempts a refresh; the
			// stub below stands in for the real `refreshProject` so we never
			// shell out to git.
			spawn: sdSpawn,
			refreshProjectFn: async (input) => {
				order.push("refresh");
				refreshedIds.push(input.id);
				const project = await repos.projects.require(input.id);
				return { project, headSha: "deadbeef", ref: input.ref ?? project.defaultBranch };
			},
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				planId: "pl-fresh",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		// The refresh fired against the dispatched project, and it ran before
		// the seeds-CLI plan walk read any on-disk state.
		expect(refreshedIds).toEqual([seedyProjectId]);
		expect(order[0]).toBe("refresh");
		expect(order).toContain("plan-show");
		expect(order.indexOf("refresh")).toBeLessThan(order.indexOf("plan-show"));
	});

	test("skips refresh when the git spawn seam is unwired (warren-6d60)", async () => {
		let refreshCalled = false;
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-noref", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const deps = await depsFor({
			repos,
			sdSpawn,
			// No `spawn` wired → refresh is skipped even if a refresher is present.
			refreshProjectFn: async (input) => {
				refreshCalled = true;
				const project = await repos.projects.require(input.id);
				return { project, headSha: "deadbeef", ref: project.defaultBranch };
			},
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				planId: "pl-noref",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		expect(refreshCalled).toBe(false);
	});

	// warren-b3be: a template with no {seed_id} would dispatch every child
	// with an identical, seed-less prompt.
	test("rejects a promptTemplate without {seed_id}: 400 + validation_error", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				planId: "pl-acc",
				agent: "claude-code",
				promptTemplate: "work on the next issue",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("{seed_id}");
	});

	test("accepts a promptTemplate carrying {seed_id} and persists it", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-acc", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				planId: "pl-acc",
				agent: "claude-code",
				promptTemplate: "read {seed_id}; close {seed_id}",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { planRun: { id: string } };
		const stored = await repos.planRuns.require(body.planRun.id);
		expect(stored.promptTemplate).toBe("read {seed_id}; close {seed_id}");
	});

	test("default template applies when promptTemplate is omitted", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-acc", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: seedyProjectId,
				planId: "pl-acc",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { planRun: { id: string } };
		const stored = await repos.planRuns.require(body.planRun.id);
		expect(stored.promptTemplate).toBe(DEFAULT_PLAN_RUN_PROMPT_TEMPLATE);
	});

	test("404 when project doesn't exist", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project: "prj_does_not_exist",
				planId: "pl-x",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(404);
	});
});

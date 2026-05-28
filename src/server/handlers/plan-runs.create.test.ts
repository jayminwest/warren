import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
	let plottedProjectId = "";
	let barePlottedProjectId = "";

	beforeEach(async () => {
		const f = await setupPlanRunFixture();
		db = f.db;
		repos = f.repos;
		projectId = f.projectId;
		seedyProjectId = f.seedyProjectId;
		plottedProjectId = f.plottedProjectId;
		barePlottedProjectId = f.barePlottedProjectId;
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

	test("persists plot_id when supplied against a plotted project", async () => {
		const calls: SdCall[] = [];
		const sdSpawn = makeSdSpawn(calls, [
			{
				match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
				result: planShowResult("pl-plot", "active", ["wa-a"]),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
				result: seedShowResult("wa-a", "open"),
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
				project: plottedProjectId,
				planId: "pl-plot",
				agent: "claude-code",
				plotId: "plot-abc",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { planRun: { id: string; plotId: string | null } };
		expect(body.planRun.plotId).toBe("plot-abc");

		// Round-trips on GET /plan-runs/:id as well.
		const detail = await fetch(`${tcpUrl(handle)}/plan-runs/${body.planRun.id}`);
		const detailBody = (await detail.json()) as { planRun: { plotId: string | null } };
		expect(detailBody.planRun.plotId).toBe("plot-abc");

		const persisted = await repos.planRuns.require(body.planRun.id);
		expect(persisted.plotId).toBe("plot-abc");
	});

	test("rejects plot_id on a project without .plot/: 400 + code=project_lacks_plot", async () => {
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
				planId: "pl-x",
				agent: "claude-code",
				plotId: "plot-abc",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; hint?: string };
		};
		expect(body.error.code).toBe("project_lacks_plot");
		expect(body.error.hint).toContain("plot init");

		// No row inserted — listActive should be empty for the seedy project.
		const rows = await repos.planRuns.listByProjectAndState(seedyProjectId);
		expect(rows).toHaveLength(0);
	});

	test("stacks seeds-gate ahead of plot-gate: hasSeeds=false + plot_id rejects with project_lacks_seeds", async () => {
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
				project: barePlottedProjectId,
				planId: "pl-x",
				agent: "claude-code",
				plotId: "plot-abc",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_seeds");

		// No row inserted on either project.
		const rows = await repos.planRuns.listByProjectAndState(barePlottedProjectId);
		expect(rows).toHaveLength(0);
	});

	test("omitting plot_id on a plotted project leaves plotId null", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-noplot", "active", ["wa-a"]),
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
				project: plottedProjectId,
				planId: "pl-noplot",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { planRun: { plotId: string | null } };
		expect(body.planRun.plotId).toBeNull();
	});

	test("empty-string plot_id is treated as not supplied (no rejection on non-plotted project)", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-empty", "active", ["wa-a"]),
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
				planId: "pl-empty",
				agent: "claude-code",
				plotId: "",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { planRun: { plotId: string | null } };
		expect(body.planRun.plotId).toBeNull();
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

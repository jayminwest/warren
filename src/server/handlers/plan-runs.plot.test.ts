import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type {
	ActivatePlanRunPlotInput,
	AppendPlanRunDispatchedInput,
} from "../../plan-runs/plot-appender.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	type CapturedLog,
	depsFor,
	makeCaptureLogger,
	makePlanRunActivator,
	makePlanRunAppender,
	makeSdSpawn,
	planShowResult,
	seedShowResult,
	setupPlanRunFixture,
	silentLogger,
	tcpUrl,
} from "./plan-runs.test-helpers.ts";

describe("POST /plan-runs — Plot integration (warren-b89f)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let plottedProjectId = "";

	beforeEach(async () => {
		const f = await setupPlanRunFixture();
		db = f.db;
		repos = f.repos;
		plottedProjectId = f.plottedProjectId;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("emits plan_run_dispatched on the bound Plot at creation time (warren-b89f)", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-emit", "active", ["wa-a", "wa-b", "wa-c"]),
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
					result: seedShowResult("wa-c", "open"),
				},
			],
		);
		const appendCalls: AppendPlanRunDispatchedInput[] = [];
		const activateCalls: ActivatePlanRunPlotInput[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planRunPlotAppender: makePlanRunAppender({ calls: appendCalls }),
			planRunPlotActivator: makePlanRunActivator({ calls: activateCalls }),
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
				project: plottedProjectId,
				planId: "pl-emit",
				agent: "claude-code",
				plotId: "plot-emit1",
				dispatcherHandle: "alice",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { planRun: { id: string } };

		expect(appendCalls).toHaveLength(1);
		const call = appendCalls[0];
		if (!call) throw new Error("appender not called");
		expect(call.plotDir).toBe("/tmp/plotted/.plot");
		expect(call.plotId).toBe("plot-emit1");
		expect(call.handle).toBe("alice");
		expect(call.planRunId).toBe(body.planRun.id);
		expect(call.planId).toBe("pl-emit");
		expect(call.childrenCount).toBe(3);

		// warren-dfff: dispatch promotes the bound Plot ready → active.
		expect(activateCalls).toHaveLength(1);
		expect(activateCalls[0]?.plotDir).toBe("/tmp/plotted/.plot");
		expect(activateCalls[0]?.plotId).toBe("plot-emit1");
		expect(activateCalls[0]?.handle).toBe("alice");
	});

	test("does NOT emit plan_run_dispatched when plotId is omitted (warren-b89f)", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-no-emit", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const appendCalls: AppendPlanRunDispatchedInput[] = [];
		const activateCalls: ActivatePlanRunPlotInput[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planRunPlotAppender: makePlanRunAppender({ calls: appendCalls }),
			planRunPlotActivator: makePlanRunActivator({ calls: activateCalls }),
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
				project: plottedProjectId,
				planId: "pl-no-emit",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		expect(appendCalls).toHaveLength(0);
		// No plotId → no promotion either.
		expect(activateCalls).toHaveLength(0);
	});

	test("defaults to handle 'operator' when dispatcherHandle is omitted (warren-b89f)", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-default", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const appendCalls: AppendPlanRunDispatchedInput[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planRunPlotAppender: makePlanRunAppender({ calls: appendCalls }),
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
				project: plottedProjectId,
				planId: "pl-default",
				agent: "claude-code",
				plotId: "plot-d",
			}),
		});
		expect(res.status).toBe(201);
		expect(appendCalls[0]?.handle).toBe("operator");
	});

	test("falls back to 'operator' when dispatcherHandle is malformed (warren-b89f)", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-bad", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const appendCalls: AppendPlanRunDispatchedInput[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planRunPlotAppender: makePlanRunAppender({ calls: appendCalls }),
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
				project: plottedProjectId,
				planId: "pl-bad",
				agent: "claude-code",
				plotId: "plot-b",
				dispatcherHandle: "@bad/handle",
			}),
		});
		expect(res.status).toBe(201);
		expect(appendCalls[0]?.handle).toBe("operator");
	});

	test("logs plan_run.plot_append_failed when the appender throws; POST still returns 201 (warren-b89f)", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-fail", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const captured: CapturedLog[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planRunPlotAppender: makePlanRunAppender({ throws: new Error("plot offline") }),
			logger: makeCaptureLogger(captured),
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
				project: plottedProjectId,
				planId: "pl-fail",
				agent: "claude-code",
				plotId: "plot-f",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { planRun: { id: string } };

		const failureLog = captured.find((c) => c.msg === "plan_run.plot_append_failed");
		expect(failureLog).toBeDefined();
		expect(failureLog?.level).toBe("warn");
		const obj = failureLog?.obj as {
			planRunId?: string;
			plotId?: string;
			err?: string;
		};
		expect(obj.planRunId).toBe(body.planRun.id);
		expect(obj.plotId).toBe("plot-f");
		expect(obj.err).toContain("plot offline");

		// Row still persists — failure was non-fatal.
		const persisted = await repos.planRuns.require(body.planRun.id);
		expect(persisted.plotId).toBe("plot-f");
	});

	test("logs plan_run.plot_activation_failed when the activator throws; POST still returns 201 (warren-dfff)", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-act-fail", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const captured: CapturedLog[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planRunPlotAppender: makePlanRunAppender({}),
			planRunPlotActivator: makePlanRunActivator({ throws: new Error("plot locked") }),
			logger: makeCaptureLogger(captured),
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
				project: plottedProjectId,
				planId: "pl-act-fail",
				agent: "claude-code",
				plotId: "plot-af",
			}),
		});
		expect(res.status).toBe(201);
		const failureLog = captured.find((c) => c.msg === "plan_run.plot_activation_failed");
		expect(failureLog).toBeDefined();
		expect(failureLog?.level).toBe("warn");
		expect((failureLog?.obj as { err?: string }).err).toContain("plot locked");
	});

	test("logs plan_run.plot_activation_skipped when the Plot is not ready (warren-dfff)", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
					result: planShowResult("pl-act-skip", "active", ["wa-a"]),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
					result: seedShowResult("wa-a", "open"),
				},
			],
		);
		const captured: CapturedLog[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planRunPlotAppender: makePlanRunAppender({}),
			planRunPlotActivator: makePlanRunActivator({ currentStatus: "active" }),
			logger: makeCaptureLogger(captured),
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
				project: plottedProjectId,
				planId: "pl-act-skip",
				agent: "claude-code",
				plotId: "plot-as",
			}),
		});
		expect(res.status).toBe(201);
		const skipLog = captured.find((c) => c.msg === "plan_run.plot_activation_skipped");
		expect(skipLog).toBeDefined();
		expect(skipLog?.level).toBe("warn");
		expect((skipLog?.obj as { currentStatus?: string }).currentStatus).toBe("active");
	});
});

describe("POST /plan-runs — plot_id validation (warren-bae5)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let plottedProjectId = "";

	beforeEach(async () => {
		const f = await setupPlanRunFixture();
		db = f.db;
		repos = f.repos;
		plottedProjectId = f.plottedProjectId;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("malformed plot_id → 400 plot_id_invalid (warren-bae5)", async () => {
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
				project: plottedProjectId,
				planId: "pl-x",
				agent: "claude-code",
				plotId: "plot_id=plot-3e72876d",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("plot_id_invalid");
		// No row inserted.
		expect(await repos.planRuns.listByProjectAndState(plottedProjectId)).toHaveLength(0);
	});

	test("well-formed but non-existent plot_id → 400 plot_id_not_found (warren-bae5)", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const resolver = {
			async resolve() {
				return null;
			},
		};
		const deps = await depsFor({ repos, sdSpawn, plotResolver: resolver });
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
				planId: "pl-x",
				agent: "claude-code",
				plotId: "plot-deadbeef",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("plot_id_not_found");
		expect(await repos.planRuns.listByProjectAndState(plottedProjectId)).toHaveLength(0);
	});
});

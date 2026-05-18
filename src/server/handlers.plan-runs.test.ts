/**
 * `handlers.plan-runs.test.ts` covers the five `POST/GET /plan-runs/*`
 * handlers added in warren-f923 / pl-a258 step 6. Follows the
 * handlers.workers.test.ts split convention — each handler lives in its
 * own describe block, and the seeds-cli + burrow surfaces are stubbed at
 * the spawn/fetch seams the deps already expose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type {
	AppendPlanRunDispatchedInput,
	PlanRunPlotAppender,
} from "../plan-runs/plot-appender.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../projects/clone.ts";
import { RunEventBroker } from "../runs/index.ts";
import { NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { BridgeRegistry, Logger, ServeHandle, ServerDeps } from "./types.ts";

const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
};

function stubFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface SdCall {
	cmd: readonly string[];
}

function makeSdSpawn(
	calls: SdCall[],
	responses: { match: (cmd: readonly string[]) => boolean; result: SpawnResult }[],
): SpawnFn {
	return async (cmd: readonly string[], _opts: SpawnOptions): Promise<SpawnResult> => {
		calls.push({ cmd });
		const matched = responses.find((r) => r.match(cmd));
		if (matched !== undefined) return matched.result;
		return { stdout: "", stderr: `no stub for ${cmd.join(" ")}`, exitCode: 1 };
	};
}

function planShowResult(planId: string, status: string, children: string[]): SpawnResult {
	return {
		stdout: JSON.stringify({
			success: true,
			plan: {
				id: planId,
				status,
				children,
				sections: { steps: children.map((title) => ({ title, blocks: [] })) },
			},
		}),
		stderr: "",
		exitCode: 0,
	};
}

function seedShowResult(id: string, status: "open" | "closed"): SpawnResult {
	return {
		stdout: JSON.stringify({
			success: true,
			issue: { id, status, blockedBy: [] },
		}),
		stderr: "",
		exitCode: 0,
	};
}

async function poolFor(repos: Repos): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stubFetch(async () => jsonRes(404, { error: { code: "not_found", message: "stub" } })),
	});
	pool.register("local", client);
	return pool;
}

interface BuildDepsInput {
	repos: Repos;
	sdSpawn: SpawnFn;
	bridges?: BridgeRegistry;
	planRunPlotAppender?: PlanRunPlotAppender;
	logger?: Logger;
	plotResolver?: import("../plots/index.ts").PlotResolver;
}

async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const pool = await poolFor(input.repos);
	return {
		repos: input.repos,
		burrowClientPool: pool,
		broker,
		bridges:
			input.bridges ??
			createBridgeRegistry({
				repos: input.repos,
				broker,
				burrowClientPool: pool,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: input.logger ?? silentLogger,
		uiDistDir: null,
		seedsCli: { sdBinary: "sd", spawn: input.sdSpawn },
		...(input.planRunPlotAppender !== undefined
			? { planRunPlotAppender: input.planRunPlotAppender }
			: {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
	};
}

function makePlanRunAppender(
	opts: { calls?: AppendPlanRunDispatchedInput[]; throws?: Error } = {},
): PlanRunPlotAppender {
	const calls = opts.calls ?? [];
	return {
		async appendPlanRunDispatched(input) {
			calls.push(input);
			if (opts.throws) throw opts.throws;
		},
	};
}

interface CapturedLog {
	level: "info" | "warn" | "error";
	obj: object;
	msg: string | undefined;
}

function makeCaptureLogger(captured: CapturedLog[]): Logger {
	return {
		info(obj, msg) {
			captured.push({ level: "info", obj, msg });
		},
		warn(obj, msg) {
			captured.push({ level: "warn", obj, msg });
		},
		error(obj, msg) {
			captured.push({ level: "error", obj, msg });
		},
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("POST /plan-runs", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";
	let seedyProjectId = "";
	let plottedProjectId = "";
	let barePlottedProjectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

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

		const seedy = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy",
			defaultBranch: "main",
			hasSeeds: true,
		});
		seedyProjectId = seedy.id;

		const bare = await repos.projects.create({
			gitUrl: "https://github.com/x/bare.git",
			localPath: "/tmp/bare",
			defaultBranch: "main",
			hasSeeds: false,
		});
		projectId = bare.id;

		const plotted = await repos.projects.create({
			gitUrl: "https://github.com/x/plotted.git",
			localPath: "/tmp/plotted",
			defaultBranch: "main",
			hasSeeds: true,
			hasPlot: true,
		});
		plottedProjectId = plotted.id;

		// Pathological shape used solely to lock in gate-stack ordering
		// (warren-909c / pl-7937 step 6): hasPlot=true but hasSeeds=false
		// means the plot-gate WOULD pass while the seeds-gate rejects.
		// The handler must fire the seeds-gate first so plot_id never
		// short-circuits the .seeds/ requirement.
		const barePlotted = await repos.projects.create({
			gitUrl: "https://github.com/x/bare-plotted.git",
			localPath: "/tmp/bare-plotted",
			defaultBranch: "main",
			hasSeeds: false,
			hasPlot: true,
		});
		barePlottedProjectId = barePlotted.id;
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
		// warren-909c / pl-7937 step 6: the handler must enforce gates in
		// order — seeds first, then plot. A project with hasPlot=true but
		// hasSeeds=false MUST still be rejected as `project_lacks_seeds`
		// when plot_id is supplied; if the gates were independent (or
		// reversed) this case would slip through to plot_lacks_seeds /
		// half-validated state. No sd or appender stubs are needed since
		// the seeds-gate short-circuits before either is invoked.
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
		const calls: SdCall[] = [];
		const sdSpawn = makeSdSpawn(calls, [
			{
				match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
				result: planShowResult("pl-noplot", "active", ["wa-a"]),
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
				planId: "pl-no-emit",
				agent: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		expect(appendCalls).toHaveLength(0);
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

/**
 * Tests for `POST /plot-plan-runs` (warren-99b2 / pl-f404 step 3 /
 * SPEC §11.Q). The handler composes plot_id validation, project +
 * .plot/ + .seeds/ gates, PlotResolver existence check, PlotReader
 * attachment fetch + candidate filter, per-candidate `sd show` status
 * probe, plan synthesis via the `planSynthesizer` seam, `sd plan show`
 * re-read, and PlanRun persistence + Plot append (mirrors POST
 * /plan-runs). Stubs layer at each seam — PlotResolver / PlotReader,
 * `planSynthesizer`, `sdSpawn` for `sd show` + `sd plan show`,
 * `planRunPlotAppender` for the Plot mirror — so no real `sd` binary
 * or disk read happens.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Attachment } from "@os-eco/plot-cli";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type {
	AppendPlanRunDispatchedInput,
	PlanRunPlotAppender,
} from "../../plan-runs/plot-appender.ts";
import type {
	PlanSynthesizer,
	SynthesizePlanInput,
	SynthesizePlanResult,
} from "../../plot-plan-runs/index.ts";
import type {
	PlotReader,
	PlotResolver,
	ReadPlotRequest,
	ReadPlotResult,
} from "../../plots/index.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../../projects/clone.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, Logger, ServeHandle, ServerDeps } from "../types.ts";

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

function makeAttachment(
	id: string,
	type: Attachment["type"],
	ref: string,
	role = "tracks",
): Attachment {
	return {
		id,
		type,
		ref,
		role,
		added_at: "2026-05-19T00:00:00.000Z",
		added_by: "user:operator",
	};
}

function makePlotReader(envelope: ReadPlotResult): PlotReader {
	return {
		async read(_input: ReadPlotRequest) {
			return envelope;
		},
	};
}

function makePlotResolver(map: Record<string, ProjectRow>): PlotResolver {
	return {
		async resolve(plotId) {
			return map[plotId] ?? null;
		},
	};
}

interface SynthesizeCall extends SynthesizePlanInput {}

function makeSynthesizer(opts: {
	calls?: SynthesizeCall[];
	result?: SynthesizePlanResult;
	error?: Error;
}): PlanSynthesizer {
	const calls = opts.calls ?? [];
	return {
		async synthesize(input) {
			calls.push(input);
			if (opts.error) throw opts.error;
			return (
				opts.result ?? {
					parentSeedId: "wa-syn",
					planId: "pl-syn",
					children: [...input.candidateSeedIds],
				}
			);
		},
	};
}

interface BuildDepsInput {
	repos: Repos;
	sdSpawn: SpawnFn;
	bridges?: BridgeRegistry;
	planRunPlotAppender?: PlanRunPlotAppender;
	planSynthesizer?: PlanSynthesizer;
	plotReader?: PlotReader;
	plotResolver?: PlotResolver;
	logger?: Logger;
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
		...(input.planSynthesizer !== undefined ? { planSynthesizer: input.planSynthesizer } : {}),
		...(input.plotReader !== undefined ? { plotReader: input.plotReader } : {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("POST /plot-plan-runs", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let plottedProject: ProjectRow;
	let seedyOnlyProject: ProjectRow;
	let bareProject: ProjectRow;

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

		plottedProject = await repos.projects.create({
			gitUrl: "https://github.com/x/plotted.git",
			localPath: "/tmp/plotted",
			defaultBranch: "main",
			hasSeeds: true,
			hasPlot: true,
		});
		seedyOnlyProject = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy",
			defaultBranch: "main",
			hasSeeds: true,
			hasPlot: false,
		});
		bareProject = await repos.projects.create({
			gitUrl: "https://github.com/x/bare.git",
			localPath: "/tmp/bare",
			defaultBranch: "main",
			hasSeeds: false,
			hasPlot: true,
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	function plotEnvelope(opts: { attachments: Attachment[]; id?: string }): ReadPlotResult {
		return {
			id: opts.id ?? "plot-deadbeef",
			name: "Test Plot",
			status: "active",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: opts.attachments,
			event_log: [],
		};
	}

	test("happy path: synthesizes plan + persists plan-run + emits Plot dispatch event", async () => {
		const sdCalls: SdCall[] = [];
		const sdSpawn = makeSdSpawn(sdCalls, [
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "warren-a",
				result: seedShowResult("warren-a", "open"),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "warren-b",
				result: seedShowResult("warren-b", "open"),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "warren-c",
				result: seedShowResult("warren-c", "open"),
			},
			{
				match: (cmd) => cmd[1] === "plan" && cmd[2] === "show" && cmd[3] === "pl-synthesized",
				result: planShowResult("pl-synthesized", "approved", ["warren-a", "warren-b", "warren-c"]),
			},
		]);
		const synthesizeCalls: SynthesizeCall[] = [];
		const appendCalls: AppendPlanRunDispatchedInput[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planSynthesizer: makeSynthesizer({
				calls: synthesizeCalls,
				result: {
					parentSeedId: "wa-parent",
					planId: "pl-synthesized",
					children: ["warren-a", "warren-b", "warren-c"],
				},
			}),
			plotReader: makePlotReader(
				plotEnvelope({
					attachments: [
						makeAttachment("att-001", "seeds_issue", "warren-a"),
						makeAttachment("att-002", "seeds_issue", "warren-b"),
						makeAttachment("att-003", "seeds_issue", "warren-c"),
					],
				}),
			),
			plotResolver: makePlotResolver({ "plot-deadbeef": plottedProject }),
			planRunPlotAppender: {
				async appendPlanRunDispatched(input) {
					appendCalls.push(input);
				},
			},
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot-deadbeef",
				project_id: plottedProject.id,
				agent_name: "claude-code",
				dispatcher_handle: "alice",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			planRun: { id: string; planId: string; plotId: string | null };
			children: { seq: number; seedId: string }[];
			synthesizedPlanId: string;
			parentSeedId: string;
		};
		expect(body.planRun.planId).toBe("pl-synthesized");
		expect(body.planRun.plotId).toBe("plot-deadbeef");
		expect(body.synthesizedPlanId).toBe("pl-synthesized");
		expect(body.parentSeedId).toBe("wa-parent");
		expect(body.children.map((c) => c.seedId)).toEqual(["warren-a", "warren-b", "warren-c"]);

		expect(synthesizeCalls).toHaveLength(1);
		expect(synthesizeCalls[0]?.candidateSeedIds).toEqual(["warren-a", "warren-b", "warren-c"]);
		expect(synthesizeCalls[0]?.plotId).toBe("plot-deadbeef");

		expect(appendCalls).toHaveLength(1);
		expect(appendCalls[0]?.plotId).toBe("plot-deadbeef");
		expect(appendCalls[0]?.handle).toBe("alice");
		expect(appendCalls[0]?.childrenCount).toBe(3);
	});

	test("filters closed seeds + sd_plan attachments before synthesis", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "warren-a",
					result: seedShowResult("warren-a", "open"),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "warren-c",
					result: seedShowResult("warren-c", "closed"),
				},
				{
					match: (cmd) => cmd[1] === "plan" && cmd[2] === "show" && cmd[3] === "pl-syn",
					result: planShowResult("pl-syn", "approved", ["warren-a"]),
				},
			],
		);
		const synthesizeCalls: SynthesizeCall[] = [];
		const deps = await depsFor({
			repos,
			sdSpawn,
			planSynthesizer: makeSynthesizer({
				calls: synthesizeCalls,
				result: { parentSeedId: "wa-p", planId: "pl-syn", children: ["warren-a"] },
			}),
			plotReader: makePlotReader(
				plotEnvelope({
					attachments: [
						makeAttachment("att-001", "seeds_issue", "warren-a"),
						// sd_plan-shaped — ref starts with pl-, excluded
						makeAttachment("att-002", "seeds_issue", "pl-12345"),
						// closed seed — excluded by sd show
						makeAttachment("att-003", "seeds_issue", "warren-c"),
						// non-seeds_issue — excluded by type
						makeAttachment("att-004", "mulch_record", "mx-deadbeef"),
					],
				}),
			),
			plotResolver: makePlotResolver({ "plot-deadbeef": plottedProject }),
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot-deadbeef",
				project_id: plottedProject.id,
				agent_name: "claude-code",
			}),
		});
		expect(res.status).toBe(201);
		expect(synthesizeCalls[0]?.candidateSeedIds).toEqual(["warren-a"]);
	});

	test("rejects malformed plot_id with 400 plot_id_invalid (warren-bae5)", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot_id=plot-3e72876d",
				project_id: plottedProject.id,
				agent_name: "claude-code",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("plot_id_invalid");
	});

	test("rejects project without .plot/ with 400 project_lacks_plot", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot-deadbeef",
				project_id: seedyOnlyProject.id,
				agent_name: "claude-code",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
	});

	test("rejects project without .seeds/ with 400 project_lacks_seeds", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot-deadbeef",
				project_id: bareProject.id,
				agent_name: "claude-code",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_seeds");
	});

	test("rejects plot_id not in this project with 400 plot_id_not_found", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({
			repos,
			sdSpawn,
			// resolver returns null for any plot_id
			plotResolver: makePlotResolver({}),
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot-orphan",
				project_id: plottedProject.id,
				agent_name: "claude-code",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("plot_id_not_found");
	});

	test("rejects Plot with zero dispatchable attachments with 400 no_dispatchable_seeds", async () => {
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "warren-closed",
					result: seedShowResult("warren-closed", "closed"),
				},
			],
		);
		const deps = await depsFor({
			repos,
			sdSpawn,
			plotReader: makePlotReader(
				plotEnvelope({
					attachments: [
						makeAttachment("att-001", "seeds_issue", "pl-99999"),
						makeAttachment("att-002", "seeds_issue", "warren-closed"),
						makeAttachment("att-003", "mulch_record", "mx-deadbeef"),
					],
				}),
			),
			plotResolver: makePlotResolver({ "plot-deadbeef": plottedProject }),
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot-deadbeef",
				project_id: plottedProject.id,
				agent_name: "claude-code",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; hint?: string } };
		expect(body.error.code).toBe("no_dispatchable_seeds");
		expect(body.error.hint).toContain("attach open seeds_issue items");
	});

	test("404 when project doesn't exist", async () => {
		const sdSpawn = makeSdSpawn([], []);
		const deps = await depsFor({ repos, sdSpawn });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot-deadbeef",
				project_id: "prj_does_not_exist",
				agent_name: "claude-code",
			}),
		});
		expect(res.status).toBe(404);
	});

	test("synthesizer error surfaces as 500 sd_plan_synthesis_error", async () => {
		const { SdPlanSynthesisError } = await import("../../plot-plan-runs/index.ts");
		const sdSpawn = makeSdSpawn(
			[],
			[
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "warren-a",
					result: seedShowResult("warren-a", "open"),
				},
				{
					match: (cmd) => cmd[1] === "show" && cmd[2] === "warren-b",
					result: seedShowResult("warren-b", "open"),
				},
			],
		);
		const deps = await depsFor({
			repos,
			sdSpawn,
			planSynthesizer: makeSynthesizer({
				error: new SdPlanSynthesisError("sd plan submit exited 1: validation error"),
			}),
			plotReader: makePlotReader(
				plotEnvelope({
					attachments: [
						makeAttachment("att-001", "seeds_issue", "warren-a"),
						makeAttachment("att-002", "seeds_issue", "warren-b"),
					],
				}),
			),
			plotResolver: makePlotResolver({ "plot-deadbeef": plottedProject }),
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plot-plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				plot_id: "plot-deadbeef",
				project_id: plottedProject.id,
				agent_name: "claude-code",
			}),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("sd_plan_synthesis_error");
	});
});

/**
 * Happy-path + filter tests for `POST /plot-plan-runs` (warren-99b2 /
 * pl-f404 step 3 / SPEC §11.Q). The handler composes plot_id
 * validation, project + .plot/ + .seeds/ gates, PlotResolver existence
 * check, PlotReader attachment fetch + candidate filter, per-candidate
 * `sd show` status probe, plan synthesis via the `planSynthesizer` seam,
 * `sd plan show` re-read, and PlanRun persistence + Plot append (mirrors
 * POST /plan-runs). Stubs layer at each seam — PlotResolver / PlotReader,
 * `planSynthesizer`, `sdSpawn` for `sd show` + `sd plan show`,
 * `planRunPlotAppender` for the Plot mirror — so no real `sd` binary or
 * disk read happens. Validation/error tests live in the sibling
 * plot-plan-runs.validation.test.ts; shared stubs/fixtures live in
 * ./plot-plan-runs.test-helpers.ts (warren-59db / pl-7c4f).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type {
	ActivatePlanRunPlotInput,
	AppendPlanRunDispatchedInput,
} from "../../plan-runs/plot-appender.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	depsFor,
	makeAttachment,
	makePlotReader,
	makePlotResolver,
	makeSdSpawn,
	makeSynthesizer,
	planShowResult,
	plotEnvelope,
	type SdCall,
	type SynthesizeCall,
	seedShowResult,
	silentLogger,
	tcpUrl,
} from "./plot-plan-runs.test-helpers.ts";

describe("POST /plot-plan-runs", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let plottedProject: ProjectRow;

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
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

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
		const activateCalls: ActivatePlanRunPlotInput[] = [];
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
			planRunPlotActivator: {
				async activatePlanRunPlot(input) {
					activateCalls.push(input);
					return { kind: "activated", previousStatus: "ready" };
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

		expect(activateCalls).toHaveLength(1);
		expect(activateCalls[0]?.plotId).toBe("plot-deadbeef");
		expect(activateCalls[0]?.handle).toBe("alice");
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
});

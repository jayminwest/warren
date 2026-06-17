/**
 * Validation/error tests for `POST /plot-plan-runs` (warren-99b2 /
 * pl-f404 step 3 / SPEC §11.Q). Covers the 400/404/500 gate paths:
 * malformed plot_id, missing .plot/, missing .seeds/, plot_id not in
 * project, zero dispatchable attachments, absent project, and a
 * synthesizer failure. The happy-path + filter tests live in the
 * sibling plot-plan-runs.test.ts; shared stubs/fixtures live in
 * ./plot-plan-runs.test-helpers.ts (warren-59db / pl-7c4f).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
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
	plotEnvelope,
	seedShowResult,
	silentLogger,
	tcpUrl,
} from "./plot-plan-runs.test-helpers.ts";

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

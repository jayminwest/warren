import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { FormalizePlotResult, PlotFormalizer } from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	depsFor,
	fakeResolver,
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.workbench.harness.ts";

describe("POST /plots/:id/formalize", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("happy path: returns suggested intent + source message count", async () => {
		const project = await seedProject(repos, { id: "proj-form", hasPlot: true });
		const { resolver } = fakeResolver({ "plot-formalize01": project });
		const formalizer: PlotFormalizer = {
			async formalize(input) {
				return {
					plot_id: input.plotId,
					suggested_intent: {
						goal: "ship it",
						non_goals: ["A"],
						constraints: ["B"],
						success_criteria: ["C"],
					},
					source_message_count: 3,
				};
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotFormalizer: formalizer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/plot-formalize01/formalize`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as FormalizePlotResult;
		expect(body.plot_id).toBe("plot-formalize01");
		expect(body.suggested_intent.goal).toBe("ship it");
		expect(body.suggested_intent.non_goals).toEqual(["A"]);
		expect(body.source_message_count).toBe(3);
	});

	test("404 when plot id is unknown to the resolver", async () => {
		const { resolver } = fakeResolver({});
		const deps = await depsFor({ repos, plotResolver: resolver });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/plots/plot-missing01/formalize`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	test("400 project_lacks_plot when project hasPlot flag is false", async () => {
		const project = await seedProject(repos, { id: "proj-noplot", hasPlot: false });
		const { resolver } = fakeResolver({ "plot-noplot00": project });
		const deps = await depsFor({ repos, plotResolver: resolver });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/plots/plot-noplot00/formalize`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
	});

	test("default formalizer reads agent_message events from runs bound to the plot", async () => {
		const project = await seedProject(repos, { id: "proj-roundtrip", hasPlot: true });
		const { resolver } = fakeResolver({ "plot-roundtrip0": project });
		await repos.agents.upsert({
			name: "brainstorm",
			renderedJson: {
				name: "brainstorm",
				version: 1,
				sections: { system: "x" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const run1 = await repos.runs.create({
			projectId: project.id,
			agentName: "brainstorm",
			renderedAgentJson: {},
			prompt: "p1",
			trigger: "brainstorm",
			mode: "conversation",
			plotId: "plot-roundtrip0",
		});
		const run2 = await repos.runs.create({
			projectId: project.id,
			agentName: "brainstorm",
			renderedAgentJson: {},
			prompt: "p2",
			trigger: "brainstorm",
			mode: "conversation",
			plotId: "plot-roundtrip0",
		});
		await repos.events.append({
			runId: run1.id,
			burrowEventSeq: 1,
			ts: "2026-05-23T00:00:00Z",
			kind: "agent_message",
			stream: "system",
			payload: { content: "**goal**: roundtrip-goal\n**non_goals**:\n- A" },
		});
		await repos.events.append({
			runId: run2.id,
			burrowEventSeq: 1,
			ts: "2026-05-23T00:01:00Z",
			kind: "agent_message",
			stream: "system",
			payload: { content: "**constraints**:\n- C1\n**success_criteria**:\n- S1" },
		});
		await repos.events.append({
			runId: run2.id,
			burrowEventSeq: 2,
			ts: "2026-05-23T00:01:30Z",
			kind: "user_message",
			stream: "system",
			payload: { content: "**goal**: must-be-ignored" },
		});

		const deps = await depsFor({ repos, plotResolver: resolver });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/plots/plot-roundtrip0/formalize`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as FormalizePlotResult;
		expect(body.suggested_intent.goal).toBe("roundtrip-goal");
		expect(body.suggested_intent.non_goals).toEqual(["A"]);
		expect(body.suggested_intent.constraints).toEqual(["C1"]);
		expect(body.suggested_intent.success_criteria).toEqual(["S1"]);
		expect(body.source_message_count).toBe(2);
	});

	test("source_message_count is 0 when no agent_message events exist", async () => {
		const project = await seedProject(repos, { id: "proj-fresh", hasPlot: true });
		const { resolver } = fakeResolver({ "plot-fresh00000": project });
		const deps = await depsFor({ repos, plotResolver: resolver });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/plots/plot-fresh00000/formalize`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as FormalizePlotResult;
		expect(body.source_message_count).toBe(0);
		expect(body.suggested_intent).toEqual({
			goal: "",
			non_goals: [],
			constraints: [],
			success_criteria: [],
		});
	});
});

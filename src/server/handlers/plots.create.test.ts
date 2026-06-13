import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { CreatePlotResult, PlotCreator, PlotSummary } from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	depsFor,
	fakeAggregator,
	fakeCreator,
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.test-support.ts";

describe("POST /plots", () => {
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

	const HAPPY_RESULT: CreatePlotResult = {
		id: "pt-new",
		name: "Fresh Plot",
		status: "drafting",
		intent_goal_preview: "ship it",
		attachments_count: 0,
		last_event_ts: "2026-05-18T01:23:45Z",
		last_event_actor: "user:operator",
	};

	test("happy path: creates a Plot in a hasPlot project and returns the PlotSummary", async () => {
		const project = await seedProject(repos, { id: "proj-plot", hasPlot: true });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({ repos, plotAggregator: agg, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: project.id,
				name: "Fresh Plot",
				intent: { goal: "ship it", non_goals: ["yak shave"] },
				dispatcher_handle: "alice",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as PlotSummary;
		expect(body).toEqual({
			id: "pt-new",
			name: "Fresh Plot",
			status: "drafting",
			intent_goal_preview: "ship it",
			attachments_count: 0,
			last_event_ts: "2026-05-18T01:23:45Z",
			last_event_actor: "user:operator",
			project_id: project.id,
		});

		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one creator call");
		expect(call.input.handle).toBe("alice");
		expect(call.input.name).toBe("Fresh Plot");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);
		expect(call.input.intent).toEqual({ goal: "ship it", non_goals: ["yak shave"] });

		expect(state.invalidates).toEqual([project.id]);
	});

	test("rejects when project.hasPlot=false with ProjectLacksPlotError", async () => {
		const project = await seedProject(repos, { id: "proj-noplot", hasPlot: false });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id, name: "Won't land" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(body.error.message).toContain(project.id);
		expect(calls).toEqual([]);
	});

	test("404s on unknown project_id", async () => {
		const deps = await depsFor({ repos, plotCreator: fakeCreator(HAPPY_RESULT).creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: "prj-missing", name: "x" }),
		});
		expect(res.status).toBe(404);
	});

	test("defaults missing name to 'Untitled Plot'", async () => {
		const project = await seedProject(repos, { id: "proj-untitled", hasPlot: true });
		const { creator, calls } = fakeCreator({ ...HAPPY_RESULT, name: "Untitled Plot" });
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id }),
		});
		expect(res.status).toBe(201);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one creator call");
		expect(call.input.name).toBe("Untitled Plot");
		expect(call.input.intent).toBeUndefined();
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-handle", hasPlot: true });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: project.id,
				name: "x",
				dispatcher_handle: "!!not a handle!!",
			}),
		});
		expect(res.status).toBe(201);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one creator call");
		expect(call.input.handle).toBe("operator");
	});

	test("rejects empty string name with 400", async () => {
		const project = await seedProject(repos, { id: "proj-emptyname", hasPlot: true });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id, name: "   " }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects unknown intent field with 400", async () => {
		const project = await seedProject(repos, { id: "proj-badintent", hasPlot: true });
		const { creator, calls } = fakeCreator(HAPPY_RESULT);
		const deps = await depsFor({ repos, plotCreator: creator });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: project.id,
				name: "x",
				intent: { goal: "ok", nongoals: ["typo"] },
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.message).toContain("nongoals");
		expect(calls).toEqual([]);
	});

	test("propagates creator errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const boom: PlotCreator = {
			async create() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({ repos, plotCreator: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: project.id, name: "x" }),
		});
		expect(res.status).toBe(500);
	});
});

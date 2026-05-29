/**
 * `plots.detail.test.ts` — `GET /plots/:id` and `GET /plots/:id/summary`
 * (warren-961e / pl-9d6a step 8, warren-8917 / pl-0344 step 15).
 *
 * Split out of the monolithic `plots.test.ts` (warren-332b / pl-369d);
 * shared seam stubs / dep builders live in `./plots.test-support.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Attachment, Intent, PlotEvent } from "@os-eco/plot-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import type {
	PlanChildAdopter,
	PlotEnvelope,
	PlotReader,
	ReadPlotResult,
} from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	createRepos,
	depsFor,
	fakeReader,
	fakeResolver,
	type Repos,
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.test-support.ts";

describe("GET /plots/:id", () => {
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

	const intent: Intent = {
		goal: "ship it",
		non_goals: ["yak shave"],
		constraints: [],
		success_criteria: ["green CI"],
	};

	const attachments: Attachment[] = [
		{
			id: "att-001",
			type: "seeds_issue",
			ref: "warren-961e",
			role: "primary",
			added_at: "2026-05-18T01:00:00Z",
			added_by: "user:alice",
		},
	];

	const events: PlotEvent[] = [
		{
			type: "plot_created",
			actor: "user:alice",
			at: "2026-05-18T01:00:00Z",
			data: { name: "P" },
		},
		{
			type: "note",
			actor: "user:alice",
			at: "2026-05-18T01:30:00Z",
			data: { text: "second" },
		},
	];

	const READ_RESULT: ReadPlotResult = {
		id: "pt-xyz",
		name: "P",
		status: "active",
		intent,
		attachments,
		event_log: events,
	};

	test("happy path: returns full envelope with project_id stitched on", async () => {
		const project = await seedProject(repos, { id: "proj-plot", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-xyz": project });
		const { reader, calls: readerCalls } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-xyz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PlotEnvelope;
		expect(body.id).toBe("pt-xyz");
		expect(body.name).toBe("P");
		expect(body.status).toBe("active");
		expect(body.intent).toEqual(intent);
		expect(body.attachments).toEqual(attachments);
		expect(body.event_log).toEqual(events);
		expect(body.project_id).toBe(project.id);

		expect(resolverCalls).toEqual(["pt-xyz"]);
		expect(readerCalls).toHaveLength(1);
		const call = readerCalls[0];
		if (call === undefined) throw new Error("expected one reader call");
		expect(call.input.plotId).toBe("pt-xyz");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);
	});

	test("404s when the resolver returns null (unknown plot_id)", async () => {
		const { resolver } = fakeResolver({});
		const { reader, calls } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("not_found");
		expect(body.error.message).toContain("pt-missing");
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const deps = await depsFor({ repos });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-anything`);
		expect(res.status).toBe(404);
	});

	test("surfaces ProjectLacksPlotError defensively when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flipped", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flipped": project });
		const { reader, calls } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flipped`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(body.error.message).toContain(project.id);
		expect(calls).toEqual([]);
	});

	test("propagates reader errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-boom": project });
		const boom: PlotReader = {
			async read() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-boom`);
		expect(res.status).toBe(500);
	});

	test("reconciles plan children before reading when seedsCli + hasSeeds (warren-18a9)", async () => {
		const project = await seedProject(repos, {
			id: "proj-adopt",
			hasPlot: true,
			hasSeeds: true,
		});
		const { resolver } = fakeResolver({ "pt-xyz": project });
		const { reader } = fakeReader(READ_RESULT);
		const adoptCalls: Array<{ plotId: string; projectPath: string }> = [];
		const planChildAdopter: PlanChildAdopter = {
			async adopt(input) {
				adoptCalls.push({ plotId: input.plotId, projectPath: input.projectPath });
				return { adopted: ["warren-bdfd"] };
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotReader: reader,
			planChildAdopter,
			seedsCli: { sdBinary: "sd", spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-xyz`);
		expect(res.status).toBe(200);
		expect(adoptCalls).toHaveLength(1);
		expect(adoptCalls[0]?.plotId).toBe("pt-xyz");
		expect(adoptCalls[0]?.projectPath).toBe(project.localPath);
	});

	test("skips reconciliation when the project has no .seeds/ (warren-18a9)", async () => {
		const project = await seedProject(repos, {
			id: "proj-no-seeds",
			hasPlot: true,
			hasSeeds: false,
		});
		const { resolver } = fakeResolver({ "pt-xyz": project });
		const { reader } = fakeReader(READ_RESULT);
		let adoptCalled = false;
		const planChildAdopter: PlanChildAdopter = {
			async adopt() {
				adoptCalled = true;
				return { adopted: [] };
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotReader: reader,
			planChildAdopter,
			seedsCli: { sdBinary: "sd", spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-xyz`);
		expect(res.status).toBe(200);
		expect(adoptCalled).toBe(false);
	});

	test("adopter failure never breaks the read (fire-and-log) (warren-18a9)", async () => {
		const project = await seedProject(repos, {
			id: "proj-adopt-boom",
			hasPlot: true,
			hasSeeds: true,
		});
		const { resolver } = fakeResolver({ "pt-xyz": project });
		const { reader } = fakeReader(READ_RESULT);
		const planChildAdopter: PlanChildAdopter = {
			async adopt() {
				throw new Error("sd on fire");
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotReader: reader,
			planChildAdopter,
			seedsCli: { sdBinary: "sd", spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-xyz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PlotEnvelope;
		expect(body.id).toBe("pt-xyz");
	});
});

/* ----------------------------------------------------------------------- */
/* GET /plots/:id/summary (warren-8917 / pl-0344 step 15)                   */
/* ----------------------------------------------------------------------- */

describe("GET /plots/:id/summary", () => {
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

	const intent: Intent = {
		goal: "ship V1.5",
		non_goals: [],
		constraints: ["no breaking changes"],
		success_criteria: ["green CI"],
	};

	const attachments: Attachment[] = [
		{
			id: "att-001",
			type: "gh_pr",
			ref: "octocat/repo#7",
			role: "implements",
			added_at: "2026-05-18T01:00:00Z",
			added_by: "user:alice",
		},
		{
			id: "att-002",
			type: "seeds_issue",
			ref: "warren-8917",
			role: "tracks",
			added_at: "2026-05-18T00:30:00Z",
			added_by: "user:alice",
		},
	];

	const events: PlotEvent[] = [
		{
			type: "plot_created",
			actor: "user:alice",
			at: "2026-05-18T00:00:00Z",
			data: { name: "P" },
		},
		{
			type: "decision_made",
			actor: "user:alice",
			at: "2026-05-18T02:00:00Z",
			data: { summary: "use sqlite", rationale: "simpler" },
		},
		{
			type: "note",
			actor: "agent:warren:run_1",
			at: "2026-05-18T03:00:00Z",
			data: { text: "pr_merged", kind: "pr_merged", ref: "octocat/repo#7" } as {
				text: string;
			} & Record<string, unknown>,
		},
		{
			type: "status_changed",
			actor: "user:alice",
			at: "2026-05-18T04:00:00Z",
			data: { from: "active", to: "done" },
		},
	];

	const READ_RESULT: ReadPlotResult = {
		id: "plot-summ",
		name: "P",
		status: "done",
		intent,
		attachments,
		event_log: events,
	};

	test("returns curated artifact payload", async () => {
		const project = await seedProject(repos, { id: "proj-summ", hasPlot: true });
		const { resolver } = fakeResolver({ "plot-summ": project });
		const { reader, calls } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/plot-summ/summary`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: string;
			name: string;
			status: string;
			project_id: string;
			intent: Intent;
			created_at: string;
			last_event_at: string;
			done_at: string | null;
			decisions: { summary: string; rationale?: string }[];
			linked_prs: { ref: string; merged_at: string | null }[];
			linked_seeds: { ref: string }[];
			timeline: { kind: string; label: string }[];
		};
		expect(body.id).toBe("plot-summ");
		expect(body.project_id).toBe(project.id);
		expect(body.status).toBe("done");
		expect(body.intent.goal).toBe("ship V1.5");
		expect(body.created_at).toBe("2026-05-18T00:00:00Z");
		expect(body.done_at).toBe("2026-05-18T04:00:00Z");
		expect(body.decisions).toHaveLength(1);
		expect(body.decisions[0]?.summary).toBe("use sqlite");
		expect(body.linked_prs).toHaveLength(1);
		expect(body.linked_prs[0]?.merged_at).toBe("2026-05-18T03:00:00Z");
		expect(body.linked_seeds).toHaveLength(1);
		expect(body.linked_seeds[0]?.ref).toBe("warren-8917");
		const kinds = body.timeline.map((t) => t.kind);
		expect(kinds).toContain("plot_created");
		expect(kinds).toContain("decision_made");
		expect(kinds).toContain("status_changed");
		expect(kinds).not.toContain("note");
		expect(calls).toHaveLength(1);
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { reader, calls } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/plot-missing/summary`);
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped", async () => {
		const project = await seedProject(repos, { id: "proj-flipped", hasPlot: false });
		const { resolver } = fakeResolver({ "plot-flipped": project });
		const { reader } = fakeReader(READ_RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotReader: reader });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/plot-flipped/summary`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
	});
});

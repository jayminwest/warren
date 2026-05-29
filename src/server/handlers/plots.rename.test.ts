/**
 * `plots.rename.test.ts` — `POST /plots/:id/rename` (warren-bed0 /
 * pl-b0c0 step 3).
 *
 * Split out of the monolithic `plots.test.ts` (warren-332b / pl-369d);
 * shared seam stubs / dep builders live in `./plots.test-support.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import type {
	PlotEnvelope,
	PlotRenamer,
	RenamePlotRequest,
	RenamePlotResult,
} from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	createRepos,
	depsFor,
	fakeAggregator,
	fakeResolver,
	type Repos,
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.test-support.ts";

/* ----------------------------------------------------------------------- */
/* POST /plots/:id/rename (warren-bed0 / pl-b0c0 step 3)                    */
/* ----------------------------------------------------------------------- */

interface FakeRenamerCall {
	readonly input: RenamePlotRequest;
}

function fakeRenamer(result: RenamePlotResult): {
	renamer: PlotRenamer;
	calls: FakeRenamerCall[];
} {
	const calls: FakeRenamerCall[] = [];
	const renamer: PlotRenamer = {
		async rename(input) {
			calls.push({ input });
			return result;
		},
	};
	return { renamer, calls };
}

describe("POST /plots/:id/rename", () => {
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

	const RESULT: RenamePlotResult = {
		id: "pt-rn",
		name: "New Name",
		status: "active",
		intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
		attachments: [],
		event_log: [
			{
				type: "plot_created",
				actor: "user:alice",
				at: "2026-05-18T01:00:00Z",
				data: { name: "Old Name" },
			},
			{
				type: "note",
				actor: "user:alice",
				at: "2026-05-18T02:00:00Z",
				data: { text: 'renamed from "Old Name" to "New Name"' },
			},
		],
	};

	test("happy path: renames and returns the full envelope + invalidates cache", async () => {
		const project = await seedProject(repos, { id: "proj-rn", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-rn": project });
		const { renamer, calls } = fakeRenamer(RESULT);
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotRenamer: renamer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-rn/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "New Name", dispatcher_handle: "alice" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as PlotEnvelope;
		expect(body.id).toBe("pt-rn");
		expect(body.name).toBe("New Name");
		expect(body.project_id).toBe(project.id);
		expect(body.event_log).toHaveLength(2);

		expect(resolverCalls).toEqual(["pt-rn"]);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one renamer call");
		expect(call.input.plotId).toBe("pt-rn");
		expect(call.input.handle).toBe("alice");
		expect(call.input.name).toBe("New Name");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);

		// Aggregator cache invalidated so a follow-up list sees the new name.
		expect(state.invalidates).toEqual([project.id]);
	});

	test("trims surrounding whitespace before threading to the renamer", async () => {
		const project = await seedProject(repos, { id: "proj-trim", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-rn": project });
		const { renamer, calls } = fakeRenamer(RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotRenamer: renamer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-rn/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "   Padded   " }),
		});
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one renamer call");
		expect(call.input.name).toBe("Padded");
	});

	test("rejects missing name with 400", async () => {
		const project = await seedProject(repos, { id: "proj-miss", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-rn": project });
		const { renamer, calls } = fakeRenamer(RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotRenamer: renamer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-rn/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects empty-after-trim name with 400", async () => {
		const project = await seedProject(repos, { id: "proj-blank", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-rn": project });
		const { renamer, calls } = fakeRenamer(RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotRenamer: renamer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-rn/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "   " }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects unknown body field with 400", async () => {
		const project = await seedProject(repos, { id: "proj-bad", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-rn": project });
		const { renamer, calls } = fakeRenamer(RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotRenamer: renamer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-rn/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x", title: "oops" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("title");
		expect(calls).toEqual([]);
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { renamer, calls } = fakeRenamer(RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotRenamer: renamer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flipped", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flipped": project });
		const { renamer, calls } = fakeRenamer(RESULT);
		const deps = await depsFor({ repos, plotResolver: resolver, plotRenamer: renamer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flipped/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("propagates generic renamer errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-rn": project });
		const boom: PlotRenamer = {
			async rename() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotRenamer: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-rn/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(500);
	});
});

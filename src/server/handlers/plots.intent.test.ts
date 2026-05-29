/**
 * `plots.intent.test.ts` — `POST /plots/:id/intent` (warren-896f /
 * pl-9d6a step 9).
 *
 * Split out of the monolithic `plots.test.ts` (warren-332b / pl-369d);
 * shared seam stubs / dep builders live in `./plots.test-support.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Intent, PlotEvent } from "@os-eco/plot-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { PlotIntentFrozenError } from "../../plots/errors.ts";
import type {
	EditPlotIntentRequest,
	EditPlotIntentResult,
	PlotEnvelope,
	PlotIntentEditor,
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
/* POST /plots/:id/intent (warren-896f / pl-9d6a step 9)                    */
/* ----------------------------------------------------------------------- */

interface FakeIntentEditorCall {
	readonly input: EditPlotIntentRequest;
}

function fakeIntentEditor(result: EditPlotIntentResult): {
	editor: PlotIntentEditor;
	calls: FakeIntentEditorCall[];
} {
	const calls: FakeIntentEditorCall[] = [];
	const editor: PlotIntentEditor = {
		async edit(input) {
			calls.push({ input });
			return result;
		},
	};
	return { editor, calls };
}

describe("POST /plots/:id/intent", () => {
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
		goal: "ship oauth",
		non_goals: ["yak shave"],
		constraints: ["no third-party"],
		success_criteria: ["green CI"],
	};

	const events: PlotEvent[] = [
		{
			type: "plot_created",
			actor: "user:alice",
			at: "2026-05-18T01:00:00Z",
			data: { name: "P" },
		},
		{
			type: "intent_edited",
			actor: "user:alice",
			at: "2026-05-18T01:30:00Z",
			data: { field: "goal", value: "ship oauth" },
		},
	];

	const RESULT: EditPlotIntentResult = {
		id: "pt-int",
		name: "P",
		status: "active",
		intent,
		attachments: [],
		event_log: events,
	};

	test("happy path: applies the patch and returns the full envelope", async () => {
		const project = await seedProject(repos, { id: "proj-int", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				goal: "ship oauth",
				non_goals: ["yak shave"],
				dispatcher_handle: "alice",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as PlotEnvelope;
		expect(body.id).toBe("pt-int");
		expect(body.intent).toEqual(intent);
		expect(body.event_log).toEqual(events);
		expect(body.project_id).toBe(project.id);

		expect(resolverCalls).toEqual(["pt-int"]);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one editor call");
		expect(call.input.plotId).toBe("pt-int");
		expect(call.input.handle).toBe("alice");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);
		expect(call.input.patch).toEqual({ goal: "ship oauth", non_goals: ["yak shave"] });

		// Aggregator cache invalidated so a follow-up list sees the new
		// intent_goal_preview without the 5s TTL.
		expect(state.invalidates).toEqual([project.id]);
	});

	test("empty body submits an empty no-op patch", async () => {
		const project = await seedProject(repos, { id: "proj-empty", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one editor call");
		expect(call.input.patch).toEqual({});
		expect(call.input.handle).toBe("operator");
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-handle", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x", dispatcher_handle: "!!nope!!" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one editor call");
		expect(call.input.handle).toBe("operator");
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({ repos, plotIntentEditor: editor });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-anything/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flipped", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flipped": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flipped/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("rejects unknown intent field with 400", async () => {
		const project = await seedProject(repos, { id: "proj-bad", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x", nongoals: ["typo"] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.message).toContain("nongoals");
		expect(calls).toEqual([]);
	});

	test("rejects non-string-array list field with 400", async () => {
		const project = await seedProject(repos, { id: "proj-arr", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const { editor, calls } = fakeIntentEditor(RESULT);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: editor,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ non_goals: "oops" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("surfaces PlotIntentFrozenError from the editor as 409", async () => {
		const project = await seedProject(repos, { id: "proj-frozen", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-done": project });
		const frozen: PlotIntentEditor = {
			async edit() {
				throw new PlotIntentFrozenError("plot pt-done is done; intent is frozen per SPEC §6");
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: frozen,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-done/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "too late" }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("plot_intent_frozen");
		expect(body.error.message).toContain("pt-done");
	});

	test("propagates generic editor errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-int": project });
		const boom: PlotIntentEditor = {
			async edit() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotIntentEditor: boom,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-int/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "x" }),
		});
		expect(res.status).toBe(500);
	});
});

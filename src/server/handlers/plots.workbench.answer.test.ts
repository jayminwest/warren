import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlotEvent } from "@os-eco/plot-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { PlotQuestionAlreadyAnsweredError, PlotQuestionNotFoundError } from "../../plots/errors.ts";
import type { AnswerPlotQuestionRequest, PlotQuestionAnswerer } from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	answeredEvent,
	depsFor,
	fakeAggregator,
	fakeQuestionAnswerer,
	fakeResolver,
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.workbench.harness.ts";

describe("POST /plots/:id/questions/:event_id/answer", () => {
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

	const EVENT_ID = "2026-05-18T04:00:00Z";

	test("happy path: appends question_answered and returns the new event", async () => {
		const project = await seedProject(repos, { id: "proj-q", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-q": project });
		const ev = answeredEvent({ question_id: EVENT_ID, text: "ship oauth" });
		const { answerer, calls } = fakeQuestionAnswerer({ event: ev });
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotQuestionAnswerer: answerer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-q/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "ship oauth", dispatcher_handle: "alice" }),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { event: PlotEvent };
		expect(body.event.type).toBe("question_answered");
		expect((body.event.data as { question_id?: string }).question_id).toBe(EVENT_ID);
		expect((body.event.data as { text?: string }).text).toBe("ship oauth");

		expect(resolverCalls).toEqual(["pt-q"]);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one answerer call");
		expect(call.input.plotId).toBe("pt-q");
		expect(call.input.eventId).toBe(EVENT_ID);
		expect(call.input.handle).toBe("alice");
		expect(call.input.answer).toBe("ship oauth");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);

		expect(state.invalidates).toEqual([project.id]);
	});

	test("decodes URL-encoded :event_id (ISO timestamps contain `:`)", async () => {
		const project = await seedProject(repos, { id: "proj-enc", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-q": project });
		const { answerer, calls } = fakeQuestionAnswerer({
			event: answeredEvent({ question_id: EVENT_ID }),
		});
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: answerer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-q/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "yes" }),
			},
		);
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one answerer call");
		expect(call.input.eventId).toBe(EVENT_ID);
	});

	test("rejects missing answer with 400", async () => {
		const project = await seedProject(repos, { id: "proj-m", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-q": project });
		const { answerer, calls } = fakeQuestionAnswerer({
			event: answeredEvent({ question_id: EVENT_ID }),
		});
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: answerer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-q/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects empty answer with 400", async () => {
		const project = await seedProject(repos, { id: "proj-em", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-q": project });
		const { answerer, calls } = fakeQuestionAnswerer({
			event: answeredEvent({ question_id: EVENT_ID }),
		});
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: answerer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-q/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "" }),
			},
		);
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-h", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-q": project });
		const { answerer, calls } = fakeQuestionAnswerer({
			event: answeredEvent({ question_id: EVENT_ID }),
		});
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: answerer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-q/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "y", dispatcher_handle: "!!nope!!" }),
			},
		);
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one answerer call");
		expect(call.input.handle).toBe("operator");
	});

	test("404s when the resolver returns null (unknown plot_id)", async () => {
		const { resolver } = fakeResolver({});
		const { answerer, calls } = fakeQuestionAnswerer({
			event: answeredEvent({ question_id: EVENT_ID }),
		});
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: answerer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-missing/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "y" }),
			},
		);
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { answerer, calls } = fakeQuestionAnswerer({
			event: answeredEvent({ question_id: EVENT_ID }),
		});
		const deps = await depsFor({ repos, plotQuestionAnswerer: answerer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-x/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "y" }),
			},
		);
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flip", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flip": project });
		const { answerer, calls } = fakeQuestionAnswerer({
			event: answeredEvent({ question_id: EVENT_ID }),
		});
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: answerer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-flip/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "y" }),
			},
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("surfaces PlotQuestionNotFoundError from the answerer as 404 (seed-pinned: pin no-such-question)", async () => {
		const project = await seedProject(repos, { id: "proj-nf", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-nf": project });
		const missing: PlotQuestionAnswerer = {
			async answer() {
				throw new PlotQuestionNotFoundError(
					`plot pt-nf has no question_posed event at ${EVENT_ID}`,
				);
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: missing,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-nf/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "y" }),
			},
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("plot_question_not_found");
		expect(body.error.message).toContain(EVENT_ID);
	});

	test("surfaces PlotQuestionAlreadyAnsweredError from the answerer as 409 (seed-pinned: already-answered rejection)", async () => {
		const project = await seedProject(repos, { id: "proj-aa", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-aa": project });
		const already: PlotQuestionAnswerer = {
			async answer() {
				throw new PlotQuestionAlreadyAnsweredError(
					`plot pt-aa question ${EVENT_ID} already has a question_answered reply`,
				);
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: already,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-aa/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "y" }),
			},
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("plot_question_already_answered");
		expect(body.error.message).toContain(EVENT_ID);
	});

	test("propagates generic answerer errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-q": project });
		const boom: PlotQuestionAnswerer = {
			async answer() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotQuestionAnswerer: boom,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-q/questions/${encodeURIComponent(EVENT_ID)}/answer`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answer: "y" }),
			},
		);
		expect(res.status).toBe(500);
	});

	test("agent-actor unreachability: answerer request type has no actor-kind field", () => {
		const probe: AnswerPlotQuestionRequest = {
			plotDir: "/x/.plot",
			plotId: "pt-x",
			handle: "alice",
			eventId: EVENT_ID,
			answer: "y",
		};
		// @ts-expect-error — `actor` is not a field on AnswerPlotQuestionRequest
		const _bad: AnswerPlotQuestionRequest = { ...probe, actor: { kind: "agent" } };
		void _bad;
		expect(Object.keys(probe).sort()).toEqual(["answer", "eventId", "handle", "plotDir", "plotId"]);
	});
});

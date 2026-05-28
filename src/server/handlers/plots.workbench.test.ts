import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlotEvent } from "@os-eco/plot-cli";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import { PlotQuestionAlreadyAnsweredError, PlotQuestionNotFoundError } from "../../plots/errors.ts";
import type {
	AnswerPlotQuestionRequest,
	AnswerPlotQuestionResult,
	FormalizePlotResult,
	PlotAggregator,
	PlotFormalizer,
	PlotQuestionAnswerer,
	PlotResolver,
	PlotSummary,
} from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";

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

interface BuildDepsInput {
	repos: Repos;
	plotAggregator?: PlotAggregator;
	plotResolver?: PlotResolver;
	plotQuestionAnswerer?: PlotQuestionAnswerer;
	plotFormalizer?: PlotFormalizer;
}

async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const pool = await poolFor(input.repos);
	return {
		repos: input.repos,
		burrowClientPool: pool,
		broker,
		bridges: createBridgeRegistry({
			repos: input.repos,
			broker,
			burrowClientPool: pool,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(input.plotAggregator !== undefined ? { plotAggregator: input.plotAggregator } : {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
		...(input.plotQuestionAnswerer !== undefined
			? { plotQuestionAnswerer: input.plotQuestionAnswerer }
			: {}),
		...(input.plotFormalizer !== undefined ? { plotFormalizer: input.plotFormalizer } : {}),
	};
}

function fakeResolver(map: Record<string, ProjectRow | null>): {
	resolver: PlotResolver;
	calls: string[];
} {
	const calls: string[] = [];
	const resolver: PlotResolver = {
		async resolve(plotId) {
			calls.push(plotId);
			return map[plotId] ?? null;
		},
	};
	return { resolver, calls };
}

async function seedProject(
	repos: Repos,
	over: Partial<ProjectRow> & { id: string },
): Promise<ProjectRow> {
	return repos.projects.create({
		id: over.id,
		gitUrl: over.gitUrl ?? `https://example.test/${over.id}.git`,
		defaultBranch: over.defaultBranch ?? "main",
		localPath: over.localPath ?? `/tmp/projects/${over.id}`,
		hasPlot: over.hasPlot ?? false,
		hasSeeds: over.hasSeeds ?? false,
	});
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

function fakeAggregator(rows: readonly PlotSummary[]): {
	agg: PlotAggregator;
	state: { invalidates: string[] };
} {
	const state = { invalidates: [] as string[] };
	const agg: PlotAggregator = {
		async listSummaries() {
			return rows;
		},
		async listNeedsAttention() {
			return [];
		},
		async countNeedsAttention() {
			return 0;
		},
		invalidate(projectId) {
			if (projectId) state.invalidates.push(projectId);
		},
	};
	return { agg, state };
}

interface FakeQuestionAnswererCall {
	readonly input: AnswerPlotQuestionRequest;
}

function fakeQuestionAnswerer(result: AnswerPlotQuestionResult): {
	answerer: PlotQuestionAnswerer;
	calls: FakeQuestionAnswererCall[];
} {
	const calls: FakeQuestionAnswererCall[] = [];
	const answerer: PlotQuestionAnswerer = {
		async answer(input) {
			calls.push({ input });
			return result;
		},
	};
	return { answerer, calls };
}

function answeredEvent(over: {
	question_id?: string;
	text?: string;
	at?: string;
	actor?: string;
}): PlotEvent {
	return {
		type: "question_answered",
		actor: over.actor ?? "user:alice",
		at: over.at ?? "2026-05-18T05:00:00Z",
		data: {
			question_id: over.question_id ?? "2026-05-18T04:00:00Z",
			text: over.text ?? "ship oauth",
		},
	};
}

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
			mode: "interactive",
			plotId: "plot-roundtrip0",
		});
		const run2 = await repos.runs.create({
			projectId: project.id,
			agentName: "brainstorm",
			renderedAgentJson: {},
			prompt: "p2",
			trigger: "brainstorm",
			mode: "interactive",
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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import type { Plot, PlotEvent } from "@os-eco/plot-cli";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { AgentDefinition } from "../registry/schema.ts";
import {
	appendAgentMessage,
	appendUserMessage,
	buildInteractivePrompt,
	INTERACTIVE_AGENT_MESSAGE_KIND,
	INTERACTIVE_USER_MESSAGE_KIND,
	type InteractivePlotContext,
	type PlotContextReader,
	spawnInteractiveTurn,
} from "./interactive.ts";

function makePlot(overrides: Partial<Plot> = {}): Plot {
	return {
		schema_version: 1,
		id: "plot-2047abc1",
		name: "test plot",
		status: "ready",
		created_at: "2026-05-23T00:00:00Z",
		updated_at: "2026-05-23T00:00:00Z",
		intent: {
			goal: "ship the interactive primitive",
			non_goals: ["redesign reap"],
			constraints: ["respect ACL"],
			success_criteria: ["spawnInteractiveTurn lands"],
		},
		attachments: [],
		...overrides,
	};
}

function stubReader(opts: {
	context?: InteractivePlotContext | null;
	throws?: Error;
	calls?: Array<{ plotDir: string; plotId: string; historyTail: number; handle: string }>;
}): PlotContextReader {
	return {
		async read(input) {
			opts.calls?.push(input);
			if (opts.throws) throw opts.throws;
			return opts.context ?? { plot: makePlot(), recentEvents: [] };
		},
	};
}

function makeAgentJson(): AgentDefinition {
	return {
		name: "brainstorm",
		version: 1,
		sections: { system: "be a brainstorm agent" },
		resolvedFrom: [],
		frontmatter: {},
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

function makeBurrowClient(): { client: BurrowClient; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetchImpl = stubFetch(async (input, init) => {
		const url = new URL(String(input), "http://localhost");
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path: url.pathname, body });
		if (method === "POST" && url.pathname === "/burrows") {
			const burrow: Burrow = {
				id: "bur_aaaaaaaaaaaa",
				parentId: null,
				kind: "task",
				name: null,
				projectRoot: "/data/projects/x/y",
				workspacePath: "/data/burrow/workspaces/bur_aaaaaaaaaaaa",
				branch: "burrow/run_x",
				provider: "local",
				providerStateJson: null,
				profileJson: {},
				state: "active",
				createdAt: new Date("2026-05-23T00:00:00Z"),
				updatedAt: new Date("2026-05-23T00:00:00Z"),
				destroyedAt: null,
			};
			return jsonResponse(201, {
				...burrow,
				createdAt: burrow.createdAt.toISOString(),
				updatedAt: burrow.updatedAt.toISOString(),
				destroyedAt: null,
			});
		}
		if (method === "POST" && /^\/burrows\/[^/]+\/runs$/.test(url.pathname)) {
			const run: BurrowRun = {
				id: "run_zzzzzzzzzzzz",
				burrowId: "bur_aaaaaaaaaaaa",
				agentId: "brainstorm",
				prompt: String(body && (body as { prompt?: string }).prompt),
				resumeOfRunId: null,
				state: "queued",
				exitCode: null,
				errorMessage: null,
				metadataJson: null,
				queuedAt: new Date("2026-05-23T00:00:01Z"),
				startedAt: null,
				completedAt: null,
			};
			return jsonResponse(201, {
				...run,
				queuedAt: run.queuedAt.toISOString(),
				startedAt: null,
				completedAt: null,
			});
		}
		return jsonResponse(404, { error: { code: "not_found", message: "x" } });
	});
	return {
		client: new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: fetchImpl,
		}),
		calls,
	};
}

async function makePool(repos: Repos, client: BurrowClient): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register("local", client);
	return pool;
}

describe("buildInteractivePrompt", () => {
	test("renders a structured plot_context block plus the user message", () => {
		const ctx: InteractivePlotContext = {
			plot: makePlot({
				attachments: [
					{
						id: "att-1",
						type: "seeds_issue",
						ref: "warren-1117",
						role: "primary",
						added_at: "2026-05-23T00:00:00Z",
						added_by: "user:alice",
					},
				],
			}),
			recentEvents: [
				{
					type: "note",
					actor: "user:alice",
					at: "2026-05-23T00:00:30Z",
					data: { text: "kickoff" },
				} as PlotEvent,
			],
		};
		const out = buildInteractivePrompt(ctx, "what's next?");
		expect(out).toContain("<plot_context>");
		expect(out).toContain('<plot id="plot-2047abc1"');
		expect(out).toContain("<goal>ship the interactive primitive</goal>");
		expect(out).toContain("- redesign reap");
		expect(out).toContain("- respect ACL");
		expect(out).toContain("- spawnInteractiveTurn lands");
		expect(out).toContain("[seeds_issue] warren-1117 (role=primary)");
		expect(out).toContain('<recent_events count="1">');
		expect(out).toContain("note");
		expect(out).toContain("<user_message>");
		expect(out).toContain("what's next?");
		expect(out).toContain("</user_message>");
	});

	test("omits plot_context when context is null but still emits user_message", () => {
		const out = buildInteractivePrompt(null, "hello");
		expect(out).not.toContain("<plot_context>");
		expect(out).toContain("<user_message>");
		expect(out).toContain("hello");
	});

	test("omits empty intent sub-lists", () => {
		const ctx: InteractivePlotContext = {
			plot: makePlot({
				intent: { goal: "g", non_goals: [], constraints: [], success_criteria: [] },
			}),
			recentEvents: [],
		};
		const out = buildInteractivePrompt(ctx, "x");
		expect(out).toContain("<goal>g</goal>");
		expect(out).not.toContain("<non_goals>");
		expect(out).not.toContain("<constraints>");
		expect(out).not.toContain("<success_criteria>");
		expect(out).not.toContain("<recent_events");
	});
});

describe("spawnInteractiveTurn", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "brainstorm", renderedJson: makeAgentJson() });
		await repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");
	});

	afterEach(async () => {
		await db.close();
	});

	async function seedPriorInteractiveRun(): Promise<string> {
		const row = await repos.runs.create({
			agentName: "brainstorm",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "<seed>",
			renderedAgentJson: makeAgentJson(),
			trigger: "interactive",
			mode: "interactive",
			plotId: "plot-2047abc1",
		});
		return row.id;
	}

	test("rejects an empty message before any side effect", async () => {
		const priorId = await seedPriorInteractiveRun();
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnInteractiveTurn({
				repos,
				burrowClientPool: await makePool(repos, client),
				runId: priorId,
				message: "   ",
				plotContextReader: stubReader({ context: { plot: makePlot(), recentEvents: [] } }),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("throws NotFoundError when the prior run does not exist", async () => {
		const { client } = makeBurrowClient();
		await expect(
			spawnInteractiveTurn({
				repos,
				burrowClientPool: await makePool(repos, client),
				runId: "run_doesnotexist",
				message: "hi",
				plotContextReader: stubReader({}),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("rejects when the prior run is not mode='interactive'", async () => {
		const batch = await repos.runs.create({
			agentName: "brainstorm",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "x",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			plotId: "plot-2047abc1",
		});
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnInteractiveTurn({
				repos,
				burrowClientPool: await makePool(repos, client),
				runId: batch.id,
				message: "hi",
				plotContextReader: stubReader({}),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("rejects when the prior interactive run has no plot_id", async () => {
		// Insert via raw SQL to bypass the spawnRun gate that pairs interactive
		// with a Plot — defense-in-depth check on the consumer side.
		const row = await repos.runs.create({
			agentName: "brainstorm",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "x",
			renderedAgentJson: makeAgentJson(),
			trigger: "interactive",
			mode: "interactive",
		});
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnInteractiveTurn({
				repos,
				burrowClientPool: await makePool(repos, client),
				runId: row.id,
				message: "hi",
				plotContextReader: stubReader({}),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("happy path: composes context, dispatches a new turn, persists user_message", async () => {
		const priorId = await seedPriorInteractiveRun();
		const readerCalls: Array<{
			plotDir: string;
			plotId: string;
			historyTail: number;
			handle: string;
		}> = [];
		const { client, calls } = makeBurrowClient();
		const result = await spawnInteractiveTurn({
			repos,
			burrowClientPool: await makePool(repos, client),
			runId: priorId,
			message: "what should we do next?",
			dispatcherHandle: "alice",
			historyTail: 5,
			plotContextReader: stubReader({
				context: { plot: makePlot(), recentEvents: [] },
				calls: readerCalls,
			}),
			plotAppender: { async appendRunDispatched() {} },
		});

		// Reader called with the right project's .plot dir + plotId + handle
		expect(readerCalls).toHaveLength(1);
		expect(readerCalls[0]?.plotDir).toBe("/data/projects/x/y/.plot");
		expect(readerCalls[0]?.plotId).toBe("plot-2047abc1");
		expect(readerCalls[0]?.handle).toBe("alice");
		expect(readerCalls[0]?.historyTail).toBe(5);

		// New turn row created, marked mode='interactive', linked to the plot
		expect(result.turn.run.id).not.toBe(priorId);
		expect(result.turn.run.mode).toBe("interactive");
		expect(result.turn.run.plotId).toBe("plot-2047abc1");
		expect(result.turn.run.agentName).toBe("brainstorm");
		expect(result.turn.run.trigger).toBe("interactive");

		// Dispatched burrow body contains the composed context + user_message
		const runCall = calls.find(
			(c) => c.method === "POST" && /^\/burrows\/[^/]+\/runs$/.test(c.path),
		);
		expect(runCall).toBeDefined();
		const prompt = String((runCall?.body as { prompt?: string }).prompt);
		expect(prompt).toContain("be a brainstorm agent"); // system prepend
		expect(prompt).toContain("<plot_context>");
		expect(prompt).toContain("<user_message>");
		expect(prompt).toContain("what should we do next?");

		// user_message event landed on the NEW turn run
		expect(result.userMessageEvent.kind).toBe(INTERACTIVE_USER_MESSAGE_KIND);
		expect(result.userMessageEvent.runId).toBe(result.turn.run.id);
		const payload = result.userMessageEvent.payloadJson as {
			actor: string;
			content: string;
		};
		expect(payload.actor).toBe("user:alice");
		expect(payload.content).toBe("what should we do next?");

		expect(result.plotContextDegraded).toBe(false);
	});

	test("plot context load failure does not block dispatch and surfaces a system event", async () => {
		const priorId = await seedPriorInteractiveRun();
		const { client } = makeBurrowClient();
		const result = await spawnInteractiveTurn({
			repos,
			burrowClientPool: await makePool(repos, client),
			runId: priorId,
			message: "go",
			plotContextReader: stubReader({ throws: new Error("index torn") }),
			plotAppender: { async appendRunDispatched() {} },
		});

		expect(result.plotContextDegraded).toBe(true);

		// user_message + plot_context_load_failed both on the new turn
		const events = await repos.events.listByRun(result.turn.run.id);
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain(INTERACTIVE_USER_MESSAGE_KIND);
		expect(kinds).toContain("plot_context_load_failed");
		const fail = events.find((e) => e.kind === "plot_context_load_failed");
		const fp = fail?.payloadJson as { plotId: string; reason: string };
		expect(fp.plotId).toBe("plot-2047abc1");
		expect(fp.reason).toBe("index torn");
	});
});

describe("appendUserMessage / appendAgentMessage", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	test("user / agent messages share monotonically-increasing seqs on the same run", async () => {
		const row = await repos.runs.create({
			agentName: "brainstorm",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "x",
			renderedAgentJson: { name: "brainstorm" },
			trigger: "interactive",
			mode: "interactive",
			plotId: "plot-aaa",
		});
		const u = await appendUserMessage({
			repos,
			runId: row.id,
			message: "hello",
			handle: "alice",
		});
		const a = await appendAgentMessage({
			repos,
			runId: row.id,
			agentName: "brainstorm",
			content: "hi back",
		});
		expect(u.kind).toBe(INTERACTIVE_USER_MESSAGE_KIND);
		expect(a.kind).toBe(INTERACTIVE_AGENT_MESSAGE_KIND);
		expect(a.burrowEventSeq).toBeGreaterThan(u.burrowEventSeq);
		const ap = a.payloadJson as { actor: string; content: string };
		expect(ap.actor).toBe(`agent:brainstorm:${row.id}`);
		expect(ap.content).toBe("hi back");
	});
});

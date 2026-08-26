/**
 * Wire-level tests for `GET /events` (pl-7e38 step 15 / warren-5eec): the
 * cross-run Event explorer query. Covers the filters (project, run, kind,
 * stream, time range), limit/offset pagination with the 500-row cap, and
 * the spectator reduction — a `readPublic`-only caller gets the same
 * per-row `projectEvent` narrowing the per-run stream applies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { EventStream } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { ANONYMOUS_ACTOR, OPERATOR_ACTOR } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { createDbSeams } from "../db-seams.ts";
import type { RouteContext, ServerDeps } from "../types.ts";
import { listEventsHandler } from "./events-query.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

interface TestEvent {
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream?: EventStream;
	readonly payload?: unknown;
}

describe("GET /events", () => {
	let db: WarrenDb;
	let repos: Repos;
	let deps: ServerDeps;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		deps = {
			repos,
			db,
			...createDbSeams(db),
			forge: new FakeForge(),
			broker: new RunEventBroker(),
			bridges: createBridgeRegistry({
				repos,
				broker: new RunEventBroker(),
				runtimeProvider: new FakeProvider(),
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
			runtimeProvider: new FakeProvider(),
			projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
			logger: silentLogger,
			uiDistDir: null,
		};
	});

	afterEach(async () => {
		await db.close();
	});

	function ctxFor(query = "", actor = OPERATOR_ACTOR): RouteContext {
		return {
			request: new Request(`http://localhost/events${query}`),
			url: new URL(`http://localhost/events${query}`),
			params: {},
			logger: silentLogger,
			requestId: "test-request-id",
			actor,
		};
	}

	async function call(
		query = "",
		actor = OPERATOR_ACTOR,
	): Promise<{
		status: number;
		body: Record<string, unknown>;
	}> {
		const handler = listEventsHandler(deps);
		try {
			const res = await handler(ctxFor(query, actor));
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		} catch (err) {
			// Direct handler invocation: validation errors render as 400s.
			if (err instanceof ValidationError) return { status: 400, body: { code: err.code } };
			throw err;
		}
	}

	let projectA: string;
	let projectB: string;
	let runA1: string;
	let runA2: string;
	let runB: string;

	/**
	 * Append in order; the autoincrement ids land 1..n, oldest-first, so id
	 * order == time order and the assertions can address rows by position.
	 */
	async function seed(events: readonly TestEvent[]): Promise<void> {
		for (const e of events)
			await repos.events.append({
				runId: e.runId,
				sandboxEventSeq: e.seq,
				ts: e.ts,
				kind: e.kind,
				stream: e.stream ?? null,
				payload: e.payload ?? null,
			});
	}

	async function seedProjectsAndRuns(): Promise<void> {
		const projA = await repos.projects.create({
			gitUrl: "https://github.com/o/a",
			localPath: "/tmp/o/a",
			defaultBranch: "main",
		});
		const projB = await repos.projects.create({
			gitUrl: "https://github.com/o/b",
			localPath: "/tmp/o/b",
			defaultBranch: "main",
		});
		projectA = projA.id;
		projectB = projB.id;
		const a1 = await repos.runs.create({
			agentName: "pi",
			projectId: projectA,
			prompt: "a1",
			renderedAgentJson: {},
			trigger: "manual",
		});
		const a2 = await repos.runs.create({
			agentName: "pi",
			projectId: projectA,
			prompt: "a2",
			renderedAgentJson: {},
			trigger: "manual",
		});
		const b = await repos.runs.create({
			agentName: "pi",
			projectId: projectB,
			prompt: "b",
			renderedAgentJson: {},
			trigger: "manual",
		});
		runA1 = a1.id;
		runA2 = a2.id;
		runB = b.id;
	}

	async function seedDefaultEvents(): Promise<void> {
		await seedProjectsAndRuns();
		await seed([
			{
				runId: runA1,
				seq: 1,
				ts: "2026-01-01T00:00:00.000Z",
				kind: "state_change",
				stream: "system",
				payload: { state: "running" },
			},
			{
				runId: runA1,
				seq: 2,
				ts: "2026-01-02T00:00:00.000Z",
				kind: "tool_use",
				stream: "stdout",
				payload: { tool: "bash" },
			},
			{
				runId: runA2,
				seq: 1,
				ts: "2026-01-03T00:00:00.000Z",
				kind: "state_change",
				stream: "system",
				payload: { state: "succeeded" },
			},
			{
				runId: runB,
				seq: 1,
				ts: "2026-01-04T00:00:00.000Z",
				kind: "tool_result",
				stream: "stderr",
				payload: { ok: true },
			},
			{
				runId: runB,
				seq: 2,
				ts: "2026-01-05T00:00:00.000Z",
				kind: "state_change",
				stream: "system",
				payload: { state: "failed" },
			},
		]);
	}

	test("returns newest-first page with the filtered total", async () => {
		await seedDefaultEvents();
		const { status, body } = await call();
		expect(status).toBe(200);
		const events = body.events as Array<Record<string, unknown>>;
		expect(events.map((e) => e.id)).toEqual([5, 4, 3, 2, 1]);
		expect(body.total).toBe(5);
		expect(body.limit).toBe(100);
		expect(body.offset).toBe(0);
	});

	test("filters by run id", async () => {
		await seedDefaultEvents();
		const { body } = await call(`?run=${encodeURIComponent(runA1)}`);
		const events = body.events as Array<Record<string, unknown>>;
		expect(events.map((e) => e.id)).toEqual([2, 1]);
		expect(body.total).toBe(2);
	});

	test("filters by project id via the runs join", async () => {
		await seedDefaultEvents();
		const { body } = await call(`?project=${encodeURIComponent(projectB)}`);
		const events = body.events as Array<Record<string, unknown>>;
		expect(events.map((e) => e.id)).toEqual([5, 4]);
		expect(events.every((e) => e.runId === runB)).toBe(true);
		expect(body.total).toBe(2);
	});

	test("filters by kind", async () => {
		await seedDefaultEvents();
		const { body } = await call("?kind=state_change");
		expect(body.total).toBe(3);
		const events = body.events as Array<Record<string, unknown>>;
		expect(events.every((e) => e.kind === "state_change")).toBe(true);
	});

	test("filters by stream and validates the vocabulary", async () => {
		await seedDefaultEvents();
		const ok = await call("?stream=system");
		expect(ok.body.total).toBe(3);
		const bad = await call("?stream=bogus");
		expect(bad.status).toBe(400);
	});

	test("filters by time range (since/until, inclusive)", async () => {
		await seedDefaultEvents();
		const { body } = await call("?since=2026-01-02T00:00:00.000Z&until=2026-01-04T00:00:00.000Z");
		const events = body.events as Array<Record<string, unknown>>;
		expect(events.map((e) => e.id)).toEqual([4, 3, 2]);
		expect(body.total).toBe(3);
	});

	test("paginates with limit and offset", async () => {
		await seedDefaultEvents();
		const page1 = await call("?limit=2");
		expect((page1.body.events as unknown[]).map((e) => (e as { id: number }).id)).toEqual([5, 4]);
		expect(page1.body.total).toBe(5);
		const page2 = await call("?limit=2&offset=2");
		expect((page2.body.events as unknown[]).map((e) => (e as { id: number }).id)).toEqual([3, 2]);
		const page3 = await call("?limit=2&offset=4");
		expect((page3.body.events as unknown[]).map((e) => (e as { id: number }).id)).toEqual([1]);
	});

	test("rejects bad pagination", async () => {
		await seedDefaultEvents();
		expect((await call("?limit=0")).status).toBe(400);
		expect((await call("?limit=501")).status).toBe(400);
		expect((await call("?limit=abc")).status).toBe(400);
		expect((await call("?offset=-1")).status).toBe(400);
	});

	test("rejects malformed time bounds", async () => {
		await seedDefaultEvents();
		expect((await call("?since=not-a-date")).status).toBe(400);
		expect((await call("?until=yesterday")).status).toBe(400);
	});

	test("spectator sees the projected rows, never operator-only content", async () => {
		await seedProjectsAndRuns();
		await seed([
			{
				runId: runA1,
				seq: 1,
				ts: "2026-01-01T00:00:00.000Z",
				kind: "tool_use",
				stream: "stdout",
				payload: { command: "echo hi" },
			},
			{
				runId: runA1,
				seq: 2,
				ts: "2026-01-02T00:00:00.000Z",
				kind: "bridge_stalled",
				stream: "system",
				payload: { sandboxId: "sbx-secret" },
			},
			{
				runId: runA2,
				seq: 1,
				ts: "2026-01-03T00:00:00.000Z",
				kind: "reap_failed",
				stream: "system",
				payload: { step: "push", message: "raw stderr /host/path", path: "/data/secret" },
			},
		]);
		const { body } = await call("", ANONYMOUS_ACTOR);
		const events = body.events as Array<Record<string, unknown>>;
		// Internal kinds are dropped whole; the failure kind survives with a
		// sanitized payload; the tool_use row passes through.
		expect(events.map((e) => e.id)).toEqual([3, 1]);
		const failure = events[0]?.payload as Record<string, unknown>;
		expect(failure.message).toBe("[redacted]");
		expect("path" in failure).toBe(false);
		expect(failure.step).toBe("push");
		// The envelope never grows operator-only keys.
		expect(Object.keys(events[0] ?? {}).sort()).toEqual(
			["id", "kind", "origin", "payload", "runId", "seq", "stream", "ts"].sort(),
		);
	});

	test("spectator payload scrubbing applies to matching secret shapes", async () => {
		await seedProjectsAndRuns();
		await seed([
			{
				runId: runA1,
				seq: 1,
				ts: "2026-01-01T00:00:00.000Z",
				kind: "tool_result",
				stream: "stdout",
				payload: { api_key: "sk-ant-supersecretvalue123456", output: "done" },
			},
		]);
		const operator = await call("");
		const opPayload = (operator.body.events as Array<{ payload: Record<string, unknown> }>)[0]
			?.payload;
		expect(opPayload?.api_key).toBe("sk-ant-supersecretvalue123456");
		const { body } = await call("", ANONYMOUS_ACTOR);
		const pubPayload = (body.events as Array<{ payload: Record<string, unknown> }>)[0]?.payload;
		expect(pubPayload?.api_key).toBe("[redacted]");
		expect(pubPayload?.output).toBe("done");
	});

	test("empty table returns an empty page", async () => {
		const { status, body } = await call();
		expect(status).toBe(200);
		expect(body.events).toEqual([]);
		expect(body.total).toBe(0);
	});
});

/**
 * Wire-level tests for `GET /events` (pl-7e38 step 15 / warren-5eec) —
 * the global events query backing the Event explorer page. Covers
 * filters (project, run, stream, kind, since/until), limit/offset
 * pagination, the `total` count, validation 400s, and the public
 * reduction (internal kinds excluded in SQL, failure payloads
 * body/log-split, payload secret-scrubbed, operator body unchanged).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, OPERATOR_ACTOR, publicReadAuth } from "../auth.ts";
import { createDbSeams } from "../db-seams.ts";
import { startServer } from "../server.ts";
import type { RouteContext, ServeHandle, ServerDeps } from "../types.ts";
import { eventsQueryHandler } from "./events-query.ts";
import { API_ROUTE_POLICIES } from "./route-table.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const TOKEN = "events-query-test-token-0000000000000000";

const silent = silentLogger;

interface WireEvent {
	id: number;
	runId: string;
	seq: number;
	ts: string;
	kind: string;
	stream: string | null;
	origin: string | null;
	payload: unknown;
}

interface EventsBody {
	events: WireEvent[];
	total: number;
	limit: number;
	offset: number;
}

async function seed(repos: Repos): Promise<{
	projectId: string;
	otherProjectId: string;
	runA: string;
	runB: string;
	runC: string;
}> {
	const project = await repos.projects.create({
		gitUrl: "https://github.com/o/r",
		localPath: "/tmp/o/r",
		defaultBranch: "main",
	});
	const otherProject = await repos.projects.create({
		gitUrl: "https://github.com/o/other",
		localPath: "/tmp/o/other",
		defaultBranch: "main",
	});
	const mkRun = (projectId: string, prompt: string) =>
		repos.runs.create({
			agentName: "pi",
			projectId,
			prompt,
			renderedAgentJson: {},
			trigger: "manual",
		});
	const runA = (await mkRun(project.id, "a")).id;
	const runB = (await mkRun(project.id, "b")).id;
	const runC = (await mkRun(otherProject.id, "c")).id;

	let seq = 0;
	const append = (
		runId: string,
		ts: string,
		kind: string,
		stream: "stdout" | "stderr" | "system" | null,
		payload: unknown,
	) => repos.events.append({ runId, sandboxEventSeq: ++seq, ts, kind, stream, payload });

	await append(runA, "2026-01-01T00:00:01.000Z", "state_change", "system", { state: "running" });
	await append(runA, "2026-01-01T00:00:02.000Z", "tool_use", "stdout", {
		name: "Bash",
		input: { command: "bun test" },
	});
	await append(runB, "2026-01-01T00:00:03.000Z", "tool_result", "stderr", { text: "boom" });
	await append(runC, "2026-01-01T00:00:04.000Z", "state_change", "system", { state: "succeeded" });
	// Public-projection cases (see ./runs/event-projection.ts).
	await append(runB, "2026-01-01T00:00:05.000Z", "bridge_stalled", null, {
		sandboxId: "sbx-internal-handle",
	});
	await append(runA, "2026-01-01T00:00:06.000Z", "reap_failed", null, {
		step: "push",
		message: "raw stderr tail with /data/host/path",
		path: "/data/hosts/workspaces/run-a",
	});
	await append(runC, "2026-01-01T00:00:07.000Z", "tool_use", "stdout", {
		input: { command: "curl -H 'Authorization: Bearer sk-ant-secret1234567890' https://x" },
	});
	return { projectId: project.id, otherProjectId: otherProject.id, runA, runB, runC };
}

function ctxFor(url: string, actor?: RouteContext["actor"]): RouteContext {
	return {
		request: new Request(`http://localhost${url}`),
		url: new URL(`http://localhost${url}`),
		params: {},
		logger: silent,
		requestId: "test-request-id",
		...(actor !== undefined ? { actor } : {}),
	};
}

describe("GET /events", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let seeded: Awaited<ReturnType<typeof seed>>;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		seeded = await seed(repos);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function serve(auth: ReturnType<typeof bearerAuth>): Promise<string> {
		const deps = await depsFor(repos, new FakeProvider());
		handle = startServer(
			{ ...deps, db, ...createDbSeams(db) },
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth,
				logger: silent,
			},
		);
		return tcpUrl(handle);
	}

	async function get(base: string, query = ""): Promise<EventsBody> {
		const res = await fetch(`${base}/events${query}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		return (await res.json()) as EventsBody;
	}

	test("lists newest-first across every run with pagination echo", async () => {
		const base = await serve(bearerAuth(TOKEN));
		const body = await get(base, "?limit=3");
		expect(body.events.map((e) => e.ts)).toEqual([
			"2026-01-01T00:00:07.000Z",
			"2026-01-01T00:00:06.000Z",
			"2026-01-01T00:00:05.000Z",
		]);
		expect(body.total).toBe(7);
		expect(body.limit).toBe(3);
		expect(body.offset).toBe(0);
		const page2 = await get(base, "?limit=3&offset=3");
		expect(page2.events).toHaveLength(3);
		expect(page2.offset).toBe(3);
	});

	test("filters by projectId via the runs join", async () => {
		const base = await serve(bearerAuth(TOKEN));
		const body = await get(base, `?projectId=${seeded.otherProjectId}`);
		expect(body.events.map((e) => e.runId)).toEqual([seeded.runC, seeded.runC]);
		expect(body.total).toBe(2);
	});

	test("filters by runId, stream, and kind", async () => {
		const base = await serve(bearerAuth(TOKEN));
		const byRun = await get(base, `?runId=${seeded.runA}`);
		expect(byRun.total).toBe(3);
		expect(byRun.events.every((e) => e.runId === seeded.runA)).toBe(true);

		const byStream = await get(base, "?stream=stdout");
		expect(byStream.total).toBe(2);
		expect(byStream.events.every((e) => e.stream === "stdout")).toBe(true);

		const byKind = await get(base, "?kind=state_change");
		expect(byKind.total).toBe(2);
		expect(byKind.events.every((e) => e.kind === "state_change")).toBe(true);
	});

	test("filters by since/until time range", async () => {
		const base = await serve(bearerAuth(TOKEN));
		const window = await get(
			base,
			"?since=2026-01-01T00:00:02.000Z&until=2026-01-01T00:00:04.000Z",
		);
		expect(window.total).toBe(3);
		expect(window.events.map((e) => e.ts)).toEqual([
			"2026-01-01T00:00:04.000Z",
			"2026-01-01T00:00:03.000Z",
			"2026-01-01T00:00:02.000Z",
		]);
		const since = await get(base, "?since=2026-01-01T00:00:06.000Z");
		expect(since.total).toBe(2);
	});

	test("rejects malformed limit, stream, and since with 400", async () => {
		const base = await serve(bearerAuth(TOKEN));
		for (const query of [
			"?limit=0",
			"?limit=501",
			"?limit=abc",
			"?offset=-1",
			"?stream=nope",
			"?since=yesterday",
		]) {
			const res = await fetch(`${base}/events${query}`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(res.status).toBe(400);
		}
	});

	test("operator body is the raw row (payload untouched)", async () => {
		const base = await serve(bearerAuth(TOKEN));
		const body = await get(base, "?kind=reap_failed");
		expect(body.total).toBe(1);
		const payload = body.events[0]?.payload as Record<string, unknown>;
		expect(payload.message).toContain("raw stderr tail");
		expect(payload.path).toBe("/data/hosts/workspaces/run-a");
	});

	test("spectator projection drops internal kinds, redacts failures, scrubs secrets", async () => {
		const base = await serve(publicReadAuth(bearerAuth(TOKEN)));
		const anon = await fetch(`${base}/events`);
		expect(anon.status).toBe(200);
		const body = (await anon.json()) as EventsBody;
		expect(body.total).toBe(6); // bridge_stalled excluded in SQL
		expect(body.events.some((e) => e.kind === "bridge_stalled")).toBe(false);

		const failure = body.events.find((e) => e.kind === "reap_failed");
		expect(failure).toBeDefined();
		const fp = failure?.payload as Record<string, unknown>;
		expect(fp.step).toBe("push");
		expect(fp.message).toBe("[redacted]");
		expect("path" in fp).toBe(false);

		const tool = body.events.find((e) => e.kind === "tool_use" && e.runId === seeded.runC);
		const tp = JSON.stringify(tool?.payload);
		expect(tp?.includes("sk-ant-secret1234567890")).toBe(false);
		expect(tp?.includes("[redacted]")).toBe(true);
	});

	test("spectator pages are internally consistent (total matches drops)", async () => {
		const base = await serve(publicReadAuth(bearerAuth(TOKEN)));
		const res = await fetch(`${base}/events?limit=10`, { headers: {} });
		const body = (await res.json()) as EventsBody;
		expect(body.events).toHaveLength(6);
	});

	test("route policy is readPublic in ROUTE_TABLE", () => {
		const entry = API_ROUTE_POLICIES.find((r) => r.method === "GET" && r.pattern === "/events");
		expect(entry?.policy).toBe("readPublic");
	});
});

describe("eventsQueryHandler (direct)", () => {
	test("serves an empty page when no dbAdapter is wired", async () => {
		const deps = {} as ServerDeps;
		const res = await eventsQueryHandler(deps)(ctxFor("/events", OPERATOR_ACTOR));
		const body = (await res.json()) as EventsBody;
		expect(body).toEqual({ events: [], total: 0, limit: 100, offset: 0 });
	});
});

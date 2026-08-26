import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { ANONYMOUS_ACTOR, bearerAuth, OPERATOR_ACTOR, publicReadAuth } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { createDbSeams } from "../db-seams.ts";
import { startServer } from "../server.ts";
import type { RouteContext, ServeHandle, ServerDeps } from "../types.ts";
import { opsOverviewHandler } from "./ops-overview.ts";
import { API_ROUTE_POLICIES } from "./route-table.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

const TOKEN = "ops-overview-test-token-00000000000000000";

async function depsFor(repos: Repos, db: WarrenDb): Promise<ServerDeps> {
	const provider = new FakeProvider();
	const broker = new RunEventBroker();
	return {
		repos,
		db,
		...createDbSeams(db),
		runtimeProvider: provider,
		forge: new FakeForge(),
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			runtimeProvider: provider,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	};
}

function ctxFor(actor?: RouteContext["actor"]): RouteContext {
	return {
		request: new Request("http://localhost/ops/overview"),
		url: new URL("http://localhost/ops/overview"),
		params: {},
		logger: silentLogger,
		requestId: "test-request-id",
		...(actor !== undefined ? { actor } : {}),
	};
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

async function seedSnapshotFixture(repos: Repos): Promise<void> {
	const project = await repos.projects.create({
		gitUrl: "https://github.com/o/r",
		localPath: "/tmp/o/r",
		defaultBranch: "main",
	});
	// Two queued runs, one running, one succeeded-with-delivery, one failed.
	const queuedA = await repos.runs.create({
		agentName: "pi",
		projectId: project.id,
		prompt: "a",
		renderedAgentJson: {},
		trigger: "manual",
	});
	const queuedB = await repos.runs.create({
		agentName: "pi",
		projectId: project.id,
		prompt: "b",
		renderedAgentJson: {},
		trigger: "manual",
	});
	const running = await repos.runs.create({
		agentName: "pi",
		projectId: project.id,
		prompt: "c",
		renderedAgentJson: {},
		trigger: "manual",
	});
	await repos.runs.markRunning(running.id);
	const succeeded = await repos.runs.create({
		agentName: "pi",
		projectId: project.id,
		prompt: "d",
		renderedAgentJson: {},
		trigger: "manual",
	});
	const failed = await repos.runs.create({
		agentName: "pi",
		projectId: project.id,
		prompt: "e",
		renderedAgentJson: {},
		trigger: "manual",
	});

	// Costs: 1.5 + 2.5 on succeeded/running, nothing elsewhere.
	await repos.runs.attachStats(succeeded.id, { costUsd: 1.5 });
	await repos.runs.attachStats(running.id, { costUsd: 2.5 });

	// Delivery: one branch push measured, one PR opened + merged.
	await repos.runs.setOutcomeFacts(succeeded.id, {
		commitsAhead: 3,
		filesChanged: 4,
		insertions: 100,
		deletions: 2,
	});
	await repos.runs.setPrUrl(succeeded.id, "https://github.com/o/r/pull/1");
	await repos.runs.setPrState(succeeded.id, "merged", "2026-01-02T00:00:00.000Z");

	await repos.runs.markRunning(succeeded.id);
	await repos.runs.finalize(succeeded.id, "succeeded");
	await repos.runs.markRunning(failed.id);
	await repos.runs.finalize(failed.id, "failed", new Date(), "crashed");

	// Interventions: two unread steering messages, different priorities.
	await repos.runInbox.enqueue({ runId: queuedA.id, body: "nudge", priority: "normal" });
	await repos.runInbox.enqueue({ runId: queuedB.id, body: "urgent nudge", priority: "high" });
}

describe("GET /ops/overview handler", () => {
	let db: WarrenDb;
	let repos: Repos;
	let deps: ServerDeps;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		deps = await depsFor(repos, db);
	});

	afterEach(async () => {
		await db.close();
	});

	test("returns the full operator snapshot (SQL-side aggregates)", async () => {
		await seedSnapshotFixture(repos);
		const res = await opsOverviewHandler(deps)(ctxFor(OPERATOR_ACTOR));
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		expect(body.runs).toMatchObject({
			byState: { queued: 2, running: 1, succeeded: 1, failed: 1, cancelled: 0 },
			nonTerminal: 3,
			total: 5,
		});
		expect(body.spend).toEqual({ totalUsd: 4, last24hUsd: 4, last24hRuns: 5 });
		expect(body.delivery).toEqual({ branchesPushed: 1, prsOpened: 1, prsMerged: 1 });
		expect(body.interventions).toEqual({
			pendingByPriority: { normal: 1, high: 1 },
			pendingTotal: 2,
		});
		expect(body.services).toMatchObject({
			dbReachable: true,
			runtime: "local",
			lifecycleStream: false,
		});
		expect(typeof body.generatedAt).toBe("string");
	});

	test("reduces the body for a readPublic-only spectator (plan risk 1)", async () => {
		await seedSnapshotFixture(repos);
		const res = await opsOverviewHandler(deps)(ctxFor(ANONYMOUS_ACTOR));
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		// Allowlist: exactly the run counts + the timestamp, nothing else.
		expect(Object.keys(body).sort()).toEqual(["generatedAt", "runs"]);
		expect((body.runs as Record<string, unknown>).byState).toEqual({
			queued: 2,
			running: 1,
			succeeded: 1,
			failed: 1,
			cancelled: 0,
		});
		// The operator-only sections never ride the public body.
		for (const key of ["spend", "delivery", "interventions", "services"]) {
			expect(body).not.toHaveProperty(key);
		}
	});

	test("degrades to dbReachable: false with zeroed counts when no db is wired", async () => {
		const noDb = { ...deps, db: undefined, dbAdapter: undefined } as ServerDeps;
		const res = await opsOverviewHandler(noDb)(ctxFor(OPERATOR_ACTOR));
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		expect(body.services).toEqual({
			dbReachable: false,
			runtime: "local",
			lifecycleStream: false,
		});
		expect(body.runs).toMatchObject({ total: 0, nonTerminal: 0 });
		expect(body.spend).toEqual({ totalUsd: 0, last24hUsd: 0, last24hRuns: 0 });
	});

	test("declares the route readPublic in ROUTE_TABLE", () => {
		const entry = API_ROUTE_POLICIES.find(
			(e) => e.method === "GET" && e.pattern === "/ops/overview",
		);
		expect(entry).toBeDefined();
		expect(entry?.policy).toBe("readPublic");
	});
});

describe("GET /ops/overview over the wire (WARREN_AUTH=public)", () => {
	let db: WarrenDb;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("anonymous spectator gets the reduced body, token holder the full one", async () => {
		const repos = createRepos(db);
		await seedSnapshotFixture(repos);
		const deps = await depsFor(repos, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
		const transport = handle.transport;
		if (transport.kind !== "tcp") throw new Error("expected tcp transport");
		const url = `http://${transport.hostname}:${transport.port}/ops/overview`;

		const anon = await bodyOf(await fetch(url));
		expect(Object.keys(anon).sort()).toEqual(["generatedAt", "runs"]);

		const authed = await bodyOf(
			await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } }),
		);
		for (const key of ["spend", "delivery", "interventions", "services"]) {
			expect(authed).toHaveProperty(key);
		}
	});
});

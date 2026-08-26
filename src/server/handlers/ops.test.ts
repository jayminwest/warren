/**
 * `GET /ops/overview` (warren-d850 / pl-7e38 step 12).
 *
 * Over the wire against a real server, under both auth postures, because
 * the acceptance criteria are about the whole surface: the one-poll
 * snapshot aggregates the seeded run/inbox facts correctly, and the
 * `WARREN_AUTH=public` spectator gets EXACTLY the reduced public
 * projection (scenario 39 is the end-to-end leak guard; this file is the
 * unit guard). Mirrors `public-projections.test.ts` / `metrics.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { buildOpsOverview, type OpsOverview } from "../../ops/overview.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { ANONYMOUS_ACTOR, bearerAuth, OPERATOR_ACTOR, publicReadAuth } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { createDbSeams } from "../db-seams.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import {
	PUBLIC_OPS_OVERVIEW_FIELDS,
	projectOpsOverview,
	REDACTED_OPS_OVERVIEW_FIELDS,
} from "./ops.ts";

const TOKEN = "ops-overview-test-token-0000000000000000000000";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function inertProvider(): FakeProvider {
	return new FakeProvider();
}

async function depsFor(repos: Repos, db: WarrenDb): Promise<ServerDeps> {
	const provider = inertProvider();
	const broker = new RunEventBroker();
	const bridges = createBridgeRegistry({
		repos,
		broker,
		runtimeProvider: provider,
		bridge: async () => ({ written: 0, skipped: 0, errored: false }),
	});
	return {
		repos,
		db,
		...createDbSeams(db),
		runtimeProvider: provider,
		forge: new FakeForge(),
		broker,
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("ops overview projection classification", () => {
	test("every OpsOverview section is classified exactly once", () => {
		const sections: (keyof OpsOverview)[] = ["runsByState", "spend", "delivery", "inbox", "health"];
		const classified = [...PUBLIC_OPS_OVERVIEW_FIELDS, ...REDACTED_OPS_OVERVIEW_FIELDS];
		expect([...classified].sort()).toEqual([...sections].sort());
		expect(new Set(classified).size).toBe(classified.length);
	});

	test("the projection is an allowlist: the anonymous copy has exactly the public sections", () => {
		const overview: OpsOverview = {
			runsByState: { queued: 1, running: 2, succeeded: 3, failed: 4, cancelled: 5 },
			spend: { windowHours: 24, recentCostUsd: 1.5, totalCostUsd: 99 },
			delivery: { branchesPushed: 7, prsOpened: 6, prsMerged: 5 },
			inbox: { byState: { unread: 2, delivered: 1, failed: 0 }, pending: 2 },
			health: {
				db: { wired: true, reachable: true, dialect: "sqlite" },
				runtimeKind: "local",
				eventBusWired: true,
			},
		};
		const projected = projectOpsOverview(overview, ANONYMOUS_ACTOR);
		expect(Object.keys(projected).sort()).toEqual(["delivery", "runsByState"]);
		expect(projected.delivery).toEqual(overview.delivery);
		// The operator copy is untouched — same reference, no narrowing.
		expect(projectOpsOverview(overview, OPERATOR_ACTOR)).toBe(overview);
	});
});

describe("GET /ops/overview", () => {
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

	/** Seed one run that ships work (PR opened + merged + commits ahead) and one that does not. */
	async function seedRuns(): Promise<void> {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
			hasSeeds: false,
		});
		const shipped = await repos.runs.create({
			agentName: "pi",
			projectId: project.id,
			prompt: "ship it",
			renderedAgentJson: { frontmatter: {} },
			trigger: "manual",
		});
		const failed = await repos.runs.create({
			agentName: "pi",
			projectId: project.id,
			prompt: "break it",
			renderedAgentJson: { frontmatter: {} },
			trigger: "manual",
		});
		await repos.runs.markRunning(shipped.id, new Date());
		await repos.runs.finalize(shipped.id, "succeeded", new Date(), null);
		await repos.runs.setPrUrl(shipped.id, "https://github.com/os-eco/warren/pull/1");
		await repos.runs.setPrState(shipped.id, "merged", new Date().toISOString());
		await repos.runs.attachStats(shipped.id, {
			costUsd: 12.5,
			tokensInput: 1000,
			tokensOutput: 200,
			tokensCacheRead: 0,
		});
		await repos.runs.setOutcomeFacts(shipped.id, {
			commitsAhead: 3,
			filesChanged: 4,
			insertions: 50,
			deletions: 2,
		});
		await repos.runs.markRunning(failed.id, new Date());
		await repos.runs.finalize(failed.id, "failed", new Date(), null);
		// Two steering messages on one run: the first is drained by the pod's
		// poll, the second lands after — still pending.
		await repos.runInbox.enqueue({ runId: failed.id, body: "stop" });
		await repos.runInbox.claimForDelivery(failed.id);
		await repos.runInbox.enqueue({ runId: failed.id, body: "steer left" });
	}

	test("the operator gets the full one-poll snapshot", async () => {
		await seedRuns();
		handle = startServer(await depsFor(repos, db), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/ops/overview`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { overview: OpsOverview };
		const overview = body.overview;
		expect(Object.keys(overview).sort()).toEqual([
			"delivery",
			"health",
			"inbox",
			"runsByState",
			"spend",
		]);
		expect(overview.runsByState).toEqual({
			queued: 0,
			running: 0,
			succeeded: 1,
			failed: 1,
			cancelled: 0,
		});
		expect(overview.spend).toEqual({ windowHours: 24, recentCostUsd: 12.5, totalCostUsd: 12.5 });
		expect(overview.delivery).toEqual({ branchesPushed: 1, prsOpened: 1, prsMerged: 1 });
		expect(overview.inbox.byState).toEqual({ unread: 1, delivered: 1, failed: 0 });
		expect(overview.inbox.pending).toBe(1);
		expect(overview.health).toEqual({
			db: { wired: true, reachable: true, dialect: "sqlite" },
			runtimeKind: "local",
			eventBusWired: false,
		});
	});

	test("an anonymous spectator gets only the reduced public projection", async () => {
		await seedRuns();
		handle = startServer(await depsFor(repos, db), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/ops/overview`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { overview: Record<string, unknown> };
		expect(Object.keys(body.overview ?? {}).sort()).toEqual(["delivery", "runsByState"]);
		// The operator-only sections never ride the anonymous body.
		expect(JSON.stringify(body)).not.toContain("spend");
		expect(JSON.stringify(body)).not.toContain("inbox");
		expect(JSON.stringify(body)).not.toContain("health");
		expect(JSON.stringify(body)).not.toContain("costUsd");
		expect(JSON.stringify(body)).not.toContain("12.5");
	});

	test("token mode refuses an anonymous caller (no silent degradation)", async () => {
		await seedRuns();
		handle = startServer(await depsFor(repos, db), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/ops/overview`);
		expect(res.status).toBe(401);
	});

	test("degrades to zeros when no db seam is wired (never throws)", async () => {
		const provider = inertProvider();
		const broker = new RunEventBroker();
		const deps: ServerDeps = {
			repos,
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
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/ops/overview`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { overview: OpsOverview };
		expect(body.overview.runsByState.queued).toBe(0);
		expect(body.overview.health.db).toEqual({ wired: false, reachable: false, dialect: null });
	});
});

describe("buildOpsOverview spend window", () => {
	test("only runs created inside the 24h window count toward recentCostUsd", async () => {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/tmp/w",
			defaultBranch: "main",
			hasSeeds: false,
		});
		const now = Date.now();
		const recent = await repos.runs.create({
			agentName: "pi",
			projectId: project.id,
			prompt: "recent",
			renderedAgentJson: { frontmatter: {} },
			trigger: "manual",
			now: new Date(now),
		});
		const old = await repos.runs.create({
			agentName: "pi",
			projectId: project.id,
			prompt: "old",
			renderedAgentJson: { frontmatter: {} },
			trigger: "manual",
			now: new Date(now - 48 * 60 * 60 * 1000),
		});
		await repos.runs.attachStats(recent.id, {
			costUsd: 3,
			tokensInput: 0,
			tokensOutput: 0,
			tokensCacheRead: 0,
		});
		await repos.runs.attachStats(old.id, {
			costUsd: 100,
			tokensInput: 0,
			tokensOutput: 0,
			tokensCacheRead: 0,
		});
		const { DrizzleAdapter } = await import("../../db/repos/drizzle-adapter.ts");
		const overview = await buildOpsOverview({
			adapter: DrizzleAdapter.for(db),
			db,
			runtimeKind: "local",
			eventBusWired: false,
			now: () => now,
		});
		expect(overview.spend).toEqual({ windowHours: 24, recentCostUsd: 3, totalCostUsd: 103 });
		await db.close();
	});
});

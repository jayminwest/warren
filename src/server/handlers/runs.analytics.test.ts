import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunState } from "../../db/schema.ts";
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

function depsFor(repos: Repos): ServerDeps {
	const broker = new RunEventBroker();
	const pool = new BurrowClientPool({ repos });
	return {
		repos,
		burrowClientPool: pool,
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			burrowClientPool: pool,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

interface SeedRunOpts {
	projectId: string;
	agentName: string;
	provider: string;
	model: string;
	seedId?: string | null;
	state: RunState;
	failureReason?: RunFailureReason | null;
	tokensInput?: number | null;
	tokensCacheRead?: number | null;
	startedAt: string;
	endedAt?: string;
}

async function seedRun(repos: Repos, opts: SeedRunOpts): Promise<void> {
	const run = await repos.runs.create({
		agentName: opts.agentName,
		projectId: opts.projectId,
		prompt: "p",
		renderedAgentJson: { frontmatter: { provider: opts.provider, model: opts.model } },
		trigger: "manual",
		seedId: opts.seedId ?? null,
		now: new Date(opts.startedAt),
	});
	await repos.runs.markRunning(run.id, new Date(opts.startedAt));
	if (opts.state !== "running" && opts.state !== "queued") {
		await repos.runs.finalize(
			run.id,
			opts.state as "succeeded" | "failed" | "cancelled",
			new Date(opts.endedAt ?? opts.startedAt),
			opts.failureReason ?? null,
		);
	}
	if (opts.tokensInput !== undefined || opts.tokensCacheRead !== undefined) {
		await repos.runs.attachStats(run.id, {
			tokensInput: opts.tokensInput ?? null,
			tokensCacheRead: opts.tokensCacheRead ?? null,
		});
	}
}

describe("GET /analytics/runs", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/o/r",
			localPath: "/tmp/r",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	function start(): void {
		handle = startServer(depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
	}

	test("returns the empty run-metrics envelope on a fresh install (warren-0692)", async () => {
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		const totals = body.totals as { runs: number; successRate: number | null };
		expect(totals.runs).toBe(0);
		expect(totals.successRate).toBeNull();
		expect(body.timeSeries).toEqual([]);
		expect(body.byAgent).toEqual([]);
		expect(body.byModel).toEqual([]);
		expect(body.byProvider).toEqual([]);
		expect(body.byFailureReason).toEqual([]);
		expect(body.topSeedsByContext).toEqual([]);
		const filter = body.filter as { projectId: string | null; from: string | null };
		expect(filter.projectId).toBeNull();
		expect(typeof filter.from).toBe("string");
	});

	test("rolls up totals, breakdowns, and top seeds across runs (warren-0692)", async () => {
		await seedRun(repos, {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			seedId: "warren-aaaa",
			state: "succeeded",
			tokensInput: 1000,
			tokensCacheRead: 500,
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		await seedRun(repos, {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			seedId: "warren-bbbb",
			state: "failed",
			failureReason: "crashed",
			tokensInput: 200,
			tokensCacheRead: 100,
			startedAt: "2026-05-21T10:00:00.000Z",
			endedAt: "2026-05-21T10:02:00.000Z",
		});
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			totals: { runs: number; succeeded: number; failed: number; successRate: number };
			byAgent: { key: string; runs: number }[];
			byFailureReason: { key: string; runs: number }[];
			topSeedsByContext: { seedId: string; contextTokensTotal: number }[];
			timeSeries: { key: string }[];
		};
		expect(body.totals.runs).toBe(2);
		expect(body.totals.succeeded).toBe(1);
		expect(body.totals.failed).toBe(1);
		expect(body.totals.successRate).toBeCloseTo(0.5);
		expect(body.byAgent[0]).toMatchObject({ key: "claude-code", runs: 2 });
		expect(body.byFailureReason).toEqual([{ key: "crashed", runs: 1 }]);
		// Highest-context seed ranks first.
		expect(body.topSeedsByContext[0]).toMatchObject({
			seedId: "warren-aaaa",
			contextTokensTotal: 1500,
		});
		expect(body.timeSeries.map((b) => b.key)).toEqual(["2026-05-20", "2026-05-21"]);
	});

	test("honors ?projectId and rejects malformed ?to (warren-0692)", async () => {
		start();
		const bad = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs?to=not-a-date`);
		expect(bad.status).toBe(400);
		const ok = await fetch(
			`${tcpUrl(handle as ServeHandle)}/analytics/runs?projectId=${projectId}`,
		);
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { filter: { projectId: string | null } };
		expect(body.filter.projectId).toBe(projectId);
	});
});

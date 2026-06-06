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
	tokensOutput?: number | null;
	tokensCacheWrite?: number | null;
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
	if (
		opts.tokensInput !== undefined ||
		opts.tokensCacheRead !== undefined ||
		opts.tokensOutput !== undefined ||
		opts.tokensCacheWrite !== undefined
	) {
		await repos.runs.attachStats(run.id, {
			tokensInput: opts.tokensInput ?? null,
			tokensCacheRead: opts.tokensCacheRead ?? null,
			tokensOutput: opts.tokensOutput ?? null,
			tokensCacheWrite: opts.tokensCacheWrite ?? null,
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

	test("tokens section: empty window yields zeroed totals and empty series, not NaN (warren-1244)", async () => {
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs`);
		expect(res.status).toBe(200);
		const { tokens } = (await res.json()) as { tokens: Record<string, unknown> };
		expect(tokens).toBeDefined();
		expect(tokens.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		for (const key of [
			"byModel",
			"byProvider",
			"timeSeries",
			"byModelTimeSeries",
			"byProviderTimeSeries",
		]) {
			expect(tokens[key]).toEqual([]);
		}
	});

	test("tokens section: aggregates all four kinds, per-model/provider breakdowns, and daily series (warren-1244)", async () => {
		// Two runs: same provider (anthropic), different models.
		await seedRun(repos, {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			state: "succeeded",
			tokensInput: 100,
			tokensOutput: 50,
			tokensCacheRead: 20,
			tokensCacheWrite: 10,
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		await seedRun(repos, {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "haiku",
			state: "succeeded",
			tokensInput: 40,
			tokensOutput: 20,
			tokensCacheRead: 5,
			tokensCacheWrite: 5,
			startedAt: "2026-05-21T12:00:00.000Z",
			endedAt: "2026-05-21T12:02:00.000Z",
		});
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tokens: {
				totals: {
					input: number;
					output: number;
					cacheRead: number;
					cacheWrite: number;
					total: number;
				};
				byModel: { key: string; tokens: { input: number; total: number } }[];
				byProvider: { key: string; tokens: { input: number; total: number } }[];
				timeSeries: { date: string; input: number; total: number }[];
				byModelTimeSeries: { key: string; series: { date: string; total: number }[] }[];
				byProviderTimeSeries: { key: string; series: { date: string; total: number }[] }[];
			};
		};
		const { tokens } = body;
		// Aggregate totals: input=140, output=70, cacheRead=25, cacheWrite=15, total=250.
		expect(tokens.totals.input).toBe(140);
		expect(tokens.totals.output).toBe(70);
		expect(tokens.totals.cacheRead).toBe(25);
		expect(tokens.totals.cacheWrite).toBe(15);
		expect(tokens.totals.total).toBe(250);
		// Per-model: sonnet=180 total, haiku=70 total (sorted desc by total).
		expect(tokens.byModel).toHaveLength(2);
		expect(tokens.byModel[0]).toMatchObject({ key: "sonnet", tokens: { input: 100, total: 180 } });
		expect(tokens.byModel[1]).toMatchObject({ key: "haiku", tokens: { input: 40, total: 70 } });
		// Per-provider: single anthropic bucket with all tokens.
		expect(tokens.byProvider).toHaveLength(1);
		expect(tokens.byProvider[0]).toMatchObject({ key: "anthropic", tokens: { total: 250 } });
		// Daily time series: two days.
		expect(tokens.timeSeries).toHaveLength(2);
		expect(tokens.timeSeries[0]).toMatchObject({ date: "2026-05-20", input: 100, total: 180 });
		expect(tokens.timeSeries[1]).toMatchObject({ date: "2026-05-21", input: 40, total: 70 });
		// Per-model time series: two series (sonnet, haiku), each with one daily bucket.
		expect(tokens.byModelTimeSeries).toHaveLength(2);
		const sonnetSeries = tokens.byModelTimeSeries.find((s) => s.key === "sonnet");
		expect(sonnetSeries?.series[0]).toMatchObject({ date: "2026-05-20", total: 180 });
		// Per-provider time series: one series (anthropic) with two daily buckets.
		expect(tokens.byProviderTimeSeries).toHaveLength(1);
		expect(tokens.byProviderTimeSeries[0]?.key).toBe("anthropic");
		expect(tokens.byProviderTimeSeries[0]?.series).toHaveLength(2);
	});

	test("tokens section: respects ?projectId filter — runs from other projects are excluded (warren-1244)", async () => {
		// Create a second project and seed a run there — it must not bleed into the filtered result.
		const otherProject = await repos.projects.create({
			gitUrl: "https://github.com/o/other",
			localPath: "/tmp/other",
			defaultBranch: "main",
		});
		await seedRun(repos, {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			state: "succeeded",
			tokensInput: 500,
			tokensOutput: 200,
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		await seedRun(repos, {
			projectId: otherProject.id,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			state: "succeeded",
			tokensInput: 9999,
			tokensOutput: 9999,
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		start();
		const res = await fetch(
			`${tcpUrl(handle as ServeHandle)}/analytics/runs?projectId=${projectId}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tokens: { totals: { input: number } };
		};
		// Only the first project's run contributes — 9999 tokens from other project must be absent.
		expect(body.tokens.totals.input).toBe(500);
	});
});

describe("GET /analytics/behavior", () => {
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

	async function seedRunReturningId(opts: SeedRunOpts): Promise<string> {
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
		return run.id;
	}

	async function toolUse(runId: string, seq: number, id: string, command: string): Promise<void> {
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: new Date(2026, 4, 20, 10, 0, seq).toISOString(),
			kind: "tool_use",
			payload: { id, input: { command } },
		});
	}

	async function toolResult(
		runId: string,
		seq: number,
		id: string,
		isError: boolean,
	): Promise<void> {
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: new Date(2026, 4, 20, 10, 0, seq).toISOString(),
			kind: "tool_result",
			payload: { tool_use_id: id, is_error: isError },
		});
	}

	test("returns an empty mining + insights envelope on a fresh install (warren-5d50)", async () => {
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			mining: {
				totals: { toolUses: number; commands: number };
				byFrequency: unknown[];
				byCategory: unknown[];
			};
			insights: unknown[];
			filter: { projectId: string | null; from: string | null };
		};
		expect(body.mining.totals.toolUses).toBe(0);
		expect(body.mining.byFrequency).toEqual([]);
		expect(body.mining.byCategory).toEqual([]);
		expect(body.insights).toEqual([]);
		expect(body.filter.projectId).toBeNull();
		expect(typeof body.filter.from).toBe("string");
	});

	test("mines commands, correlates failures, and surfaces os-eco highlights (warren-5d50)", async () => {
		const runId = await seedRunReturningId({
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			seedId: "warren-aaaa",
			state: "failed",
			failureReason: "crashed",
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		// `bun run check:all` fails, is re-run, and fails again (a stuck loop).
		await toolUse(runId, 1, "u1", "bun run check:all");
		await toolResult(runId, 2, "u1", true);
		await toolUse(runId, 3, "u2", "bun run check:all");
		await toolResult(runId, 4, "u2", true);
		await toolUse(runId, 5, "u3", "ls -la");
		await toolResult(runId, 6, "u3", false);

		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			mining: {
				totals: { toolUses: number; commands: number; failures: number };
				byFrequency: { command: string; invocations: number; failures: number }[];
				byStuckScore: { command: string; stuckScore: number }[];
				osEcoCommands: { command: string; osEco: boolean }[];
			};
			insights: { kind: string; subject: string | null }[];
		};
		expect(body.mining.totals.toolUses).toBe(3);
		expect(body.mining.totals.failures).toBe(2);
		const checkAll = body.mining.byFrequency.find((c) => c.command === "bun run check:all");
		expect(checkAll).toMatchObject({ invocations: 2, failures: 2 });
		expect(body.mining.byStuckScore[0]).toMatchObject({
			command: "bun run check:all",
			stuckScore: 1,
		});
		expect(body.mining.osEcoCommands.map((c) => c.command)).toContain("bun run check:all");
		// Derived insights flag the stuck/failed command.
		const kinds = body.insights.map((i) => i.kind);
		expect(kinds).toContain("most-failed-command");
		expect(kinds).toContain("most-retried-command");
	});

	test("rejects malformed ?from (warren-5d50)", async () => {
		start();
		const bad = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior?from=nope`);
		expect(bad.status).toBe(400);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	depsFor,
	NO_AUTH,
	seedRun,
	setRunPrState,
	silentLogger,
	tcpUrl,
	WINDOW,
} from "./runs.analytics.test-helpers.ts";

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
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs?${WINDOW}`);
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

	test("outcomes section: steering cohorts and cost per merged PR (warren-be04)", async () => {
		const steeredId = await seedRun(repos, {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			state: "succeeded",
			costUsd: 4,
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		const unsteeredId = await seedRun(repos, {
			projectId,
			agentName: "pi",
			provider: "anthropic",
			model: "sonnet",
			state: "succeeded",
			costUsd: 2,
			startedAt: "2026-05-21T10:00:00.000Z",
			endedAt: "2026-05-21T10:05:00.000Z",
		});
		await setRunPrState(repos, steeredId, "merged");
		await setRunPrState(repos, unsteeredId, "closed_unmerged");
		await repos.events.append({
			runId: steeredId,
			sandboxEventSeq: 1,
			ts: "2026-05-20T10:02:00.000Z",
			kind: "steer.sent",
			payload: { text: "try again" },
		});
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs?${WINDOW}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			outcomes: {
				steering: {
					steered: { runs: number; prStateKnown: number; prsMerged: number; mergedPrRate: number };
					unsteered: {
						runs: number;
						prStateKnown: number;
						prsMerged: number;
						mergedPrRate: number;
					};
					mergedPrRateDelta: number;
					confidence: string;
				};
				costPerMergedPr: {
					overall: { costUsd: number; prsMerged: number; costPerMergedPrUsd: number };
					byAgent: { key: string; costPerMergedPrUsd: number | null }[];
				};
			};
		};
		expect(body.outcomes.steering.steered).toMatchObject({
			runs: 1,
			prStateKnown: 1,
			prsMerged: 1,
			mergedPrRate: 1,
		});
		expect(body.outcomes.steering.unsteered).toMatchObject({
			runs: 1,
			prStateKnown: 1,
			prsMerged: 0,
			mergedPrRate: 0,
		});
		expect(body.outcomes.steering.mergedPrRateDelta).toBe(1);
		expect(body.outcomes.steering.confidence).toBe("low");
		// Total priced cost (4 + 2) over one merged PR.
		expect(body.outcomes.costPerMergedPr.overall).toMatchObject({
			costUsd: 6,
			prsMerged: 1,
			costPerMergedPrUsd: 6,
		});
		const claude = body.outcomes.costPerMergedPr.byAgent.find((b) => b.key === "claude-code");
		expect(claude?.costPerMergedPrUsd).toBe(4);
	});

	test("delivery block + outcomes.autonomy: timings from push/PR events and merge facts (warren-bc9c)", async () => {
		const runId = await seedRun(repos, {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			state: "succeeded",
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		// setRunPrState stamps pr_merged_at = 2026-05-21T00:00:00.000Z on merge.
		await setRunPrState(repos, runId, "merged");
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: "2026-05-20T10:05:10.000Z",
			kind: "reap.branch_pushed",
			payload: { branch: "warren/x" },
		});
		await repos.events.append({
			runId,
			sandboxEventSeq: 2,
			ts: "2026-05-20T10:06:10.000Z",
			kind: "reap.pr_opened",
			payload: { prUrl: "https://github.com/o/r/pull/1" },
		});
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs?${WINDOW}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			delivery: {
				branchPushToPrOpenMs: { median: number | null; count: number };
				prOpenToMergeMs: { median: number | null; count: number };
				dispatchToMergeMs: { median: number | null; count: number };
				endToMergeMs: { median: number | null; count: number };
			};
			outcomes: { autonomy: { merged: number; autonomous: number; rate: number | null } };
		};
		expect(body.delivery.branchPushToPrOpenMs).toMatchObject({ median: 60_000, count: 1 });
		expect(body.delivery.prOpenToMergeMs.count).toBe(1);
		expect(body.delivery.dispatchToMergeMs.count).toBe(1);
		expect(body.delivery.endToMergeMs.count).toBe(1);
		// merged, never steered, first attempt.
		expect(body.outcomes.autonomy).toMatchObject({ merged: 1, autonomous: 1, rate: 1 });
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
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/runs?${WINDOW}`);
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
			`${tcpUrl(handle as ServeHandle)}/analytics/runs?projectId=${projectId}&${WINDOW}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tokens: { totals: { input: number } };
		};
		// Only the first project's run contributes — 9999 tokens from other project must be absent.
		expect(body.tokens.totals.input).toBe(500);
	});
});

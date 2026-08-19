/**
 * Handler tests for GET /analytics/dispatch (warren-5423).
 */

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

describe("GET /analytics/dispatch", () => {
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

	async function seedDispatch(opts: {
		createdAt: string;
		dispatchOrigin?: string | null;
		retryKind?: string | null;
		provider?: string | null;
		model?: string | null;
		queueQueuedRuns?: number | null;
		queueRunningRuns?: number | null;
		state?: "succeeded" | "failed" | "cancelled";
		failureReason?: "crashed" | "sandbox_run_lost" | null;
		costUsd?: number | null;
		prState?: "open" | "merged" | "closed_unmerged";
	}): Promise<string> {
		const runId = await seedRun(repos, {
			projectId,
			agentName: "claude-code",
			provider: opts.provider ?? "anthropic",
			model: opts.model ?? "sonnet",
			state: opts.state ?? "succeeded",
			failureReason: opts.failureReason ?? null,
			costUsd: opts.costUsd ?? 0.25,
			startedAt: opts.createdAt,
			endedAt: opts.createdAt,
		});
		if (opts.prState !== undefined) {
			await setRunPrState(repos, runId, opts.prState);
		}
		await repos.dispatchContext.insert({
			runId,
			createdAt: opts.createdAt,
			agentName: "claude-code",
			provider: opts.provider ?? "anthropic",
			model: opts.model ?? "sonnet",
			dispatchOrigin: opts.dispatchOrigin ?? "api",
			retryKind: opts.retryKind ?? "none",
			queueQueuedRuns: opts.queueQueuedRuns ?? 0,
			queueRunningRuns: opts.queueRunningRuns ?? 1,
			queueProjectNonTerminal: (opts.queueQueuedRuns ?? 0) + (opts.queueRunningRuns ?? 1),
			queueSnapshotSource: "runs_table",
		});
		return runId;
	}

	test("returns the empty envelope on a fresh install (warren-5423)", async () => {
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/dispatch`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			totals: { dispatches: number };
			byDispatchOrigin: unknown[];
			rows: unknown[];
			filter: { projectId: string | null; from: string | null };
		};
		expect(body.totals.dispatches).toBe(0);
		expect(body.byDispatchOrigin).toEqual([]);
		expect(body.rows).toEqual([]);
		expect(body.filter.projectId).toBeNull();
		expect(typeof body.filter.from).toBe("string");
	});

	test("joins run outcome and groups counts (warren-5423)", async () => {
		const r1 = await seedDispatch({
			createdAt: "2026-05-20T10:00:00.000Z",
			dispatchOrigin: "api",
			retryKind: "none",
			state: "succeeded",
			costUsd: 1.0,
			prState: "merged",
			queueQueuedRuns: 0,
			queueRunningRuns: 1,
		});
		const r2 = await seedDispatch({
			createdAt: "2026-05-21T10:00:00.000Z",
			dispatchOrigin: "cron",
			retryKind: "infra_lost",
			state: "failed",
			failureReason: "sandbox_run_lost",
			provider: "anthropic",
			model: "opus",
			queueQueuedRuns: 2,
			queueRunningRuns: 1,
		});
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/dispatch?${WINDOW}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			totals: { dispatches: number };
			byDispatchOrigin: { key: string; count: number }[];
			byRetryKind: { key: string; count: number }[];
			byProviderModel: { key: string; count: number }[];
			byQueueDepth: { key: string; count: number }[];
			rows: {
				runId: string;
				state: string;
				failureReason: string | null;
				costUsd: number | null;
				prState: string | null;
				dispatchOrigin: string | null;
			}[];
		};
		expect(body.totals.dispatches).toBe(2);
		expect(body.byDispatchOrigin).toEqual([
			{ key: "api", count: 1 },
			{ key: "cron", count: 1 },
		]);
		// Equal counts break ties by key ascending.
		expect(body.byRetryKind).toEqual([
			{ key: "infra_lost", count: 1 },
			{ key: "none", count: 1 },
		]);
		expect(body.byProviderModel).toEqual([
			{ key: "anthropic/opus", count: 1 },
			{ key: "anthropic/sonnet", count: 1 },
		]);
		expect(body.byQueueDepth).toEqual([
			{ key: "1", count: 1 },
			{ key: "3", count: 1 },
		]);
		// Newest first (created_at desc).
		expect(body.rows.map((r) => r.runId)).toEqual([r2, r1]);
		expect(body.rows[0]).toMatchObject({
			runId: r2,
			state: "failed",
			failureReason: "sandbox_run_lost",
			dispatchOrigin: "cron",
		});
		expect(body.rows[1]).toMatchObject({
			runId: r1,
			state: "succeeded",
			costUsd: 1.0,
			prState: "merged",
			dispatchOrigin: "api",
		});
	});

	test("windows on created_at so never-started dispatches are included (warren-5423)", async () => {
		// A run that never left queued — startedAt stays null after create.
		// seedRun always markRunning; seed manually instead.
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "p",
			renderedAgentJson: { frontmatter: { provider: "anthropic", model: "sonnet" } },
			trigger: "manual",
			now: new Date("2026-05-20T10:00:00.000Z"),
		});
		// Leave state=queued, startedAt=null. listForAnalytics (started_at)
		// would drop this; listForAnalytics on dispatch_context must not.
		await repos.dispatchContext.insert({
			runId: run.id,
			createdAt: "2026-05-20T10:00:00.000Z",
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			dispatchOrigin: "api",
			retryKind: "none",
			queueQueuedRuns: 1,
			queueRunningRuns: 0,
			queueProjectNonTerminal: 1,
			queueSnapshotSource: "runs_table",
		});
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/dispatch?${WINDOW}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			totals: { dispatches: number };
			rows: { runId: string; state: string }[];
		};
		expect(body.totals.dispatches).toBe(1);
		expect(body.rows[0]).toMatchObject({ runId: run.id, state: "queued" });
	});

	test("rejects a malformed ?from (warren-5423)", async () => {
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/dispatch?from=not-a-date`);
		expect(res.status).toBe(400);
	});

	test("filters by projectId", async () => {
		const other = await repos.projects.create({
			gitUrl: "https://github.com/o/other",
			localPath: "/tmp/other",
			defaultBranch: "main",
		});
		await seedDispatch({ createdAt: "2026-05-20T10:00:00.000Z" });
		const otherRun = await repos.runs.create({
			agentName: "claude-code",
			projectId: other.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			now: new Date("2026-05-20T10:00:00.000Z"),
		});
		await repos.dispatchContext.insert({
			runId: otherRun.id,
			createdAt: "2026-05-20T10:00:00.000Z",
			dispatchOrigin: "cli",
			retryKind: "none",
		});
		start();
		const res = await fetch(
			`${tcpUrl(handle as ServeHandle)}/analytics/dispatch?projectId=${projectId}&${WINDOW}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			totals: { dispatches: number };
			filter: { projectId: string | null };
			byDispatchOrigin: { key: string; count: number }[];
		};
		expect(body.filter.projectId).toBe(projectId);
		expect(body.totals.dispatches).toBe(1);
		expect(body.byDispatchOrigin).toEqual([{ key: "api", count: 1 }]);
	});
});

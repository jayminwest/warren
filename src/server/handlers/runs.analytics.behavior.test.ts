import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	depsFor,
	NO_AUTH,
	seedRun as seedRunReturningId,
	setRunPrState,
	silentLogger,
	tcpUrl,
	WINDOW,
} from "./runs.analytics.test-helpers.ts";

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

	// warren-7746: /analytics/behavior reads the structured tool_calls
	// rollup, so tests seed rollup rows (one per tool_use, with the
	// tool_result's is_error pre-joined) instead of raw event payloads.
	async function toolCall(
		runId: string,
		seq: number,
		id: string,
		command: string,
		isError: boolean,
	): Promise<void> {
		await repos.toolCalls.recordUse({
			runId,
			seq,
			ts: new Date(2026, 4, 20, 10, 0, seq).toISOString(),
			toolName: "Bash",
			command,
			filePaths: [],
			toolUseId: id,
		});
		await repos.toolCalls.recordResult({ runId, toolUseId: id, isError, resultBytes: null });
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
		const runId = await seedRunReturningId(repos, {
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
		await toolCall(runId, 1, "u1", "bun run check:all", true);
		await toolCall(runId, 3, "u2", "bun run check:all", true);
		await toolCall(runId, 5, "u3", "ls -la", false);

		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior?${WINDOW}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			mining: {
				totals: { toolUses: number; commands: number; failures: number };
				byFrequency: { command: string; invocations: number; failures: number }[];
				byStuckScore: { command: string; stuckScore: number }[];
				osEcoCommands: { command: string; osEco: boolean }[];
			};
			insights: { kind: string; subject: string | null }[];
			truncated: boolean;
		};
		expect(body.truncated).toBe(false);
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

	test("emits the outcome-joined insight kinds over resolved pr_state (warren-be04)", async () => {
		// 4 steered runs, all merged; 4 unsteered runs, one merged.
		for (let i = 0; i < 8; i += 1) {
			const steered = i < 4;
			const runId = await seedRunReturningId(repos, {
				projectId,
				agentName: "claude-code",
				provider: "anthropic",
				model: "sonnet",
				state: "succeeded",
				costUsd: 1,
				startedAt: `2026-05-2${i}T10:00:00.000Z`,
				endedAt: `2026-05-2${i}T10:05:00.000Z`,
			});
			await setRunPrState(repos, runId, steered || i === 4 ? "merged" : "closed_unmerged");
			if (steered) {
				await repos.events.append({
					runId,
					sandboxEventSeq: 1,
					ts: `2026-05-2${i}T10:02:00.000Z`,
					kind: "steer.sent",
					payload: { text: "nudge" },
				});
			}
		}
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior?${WINDOW}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			insights: {
				kind: string;
				severity: string;
				value: number;
				denominator?: number;
				confidence?: string;
			}[];
			outcomes: { steering: { mergedPrRateDelta: number } };
		};
		const delta = body.insights.find((i) => i.kind === "steering-outcome-delta");
		expect(delta).toBeDefined();
		expect(delta?.severity).toBe("info");
		expect(delta?.value).toBeCloseTo(0.75, 5);
		expect(delta?.denominator).toBe(8);
		expect(delta?.confidence).toBe("low");
		const cost = body.insights.find((i) => i.kind === "cost-per-merged-pr");
		expect(cost).toBeDefined();
		// $8 of priced cost over 5 merged PRs.
		expect(cost?.value).toBeCloseTo(1.6, 5);
		expect(cost?.denominator).toBe(5);
		expect(body.outcomes.steering.mergedPrRateDelta).toBeCloseTo(0.75, 5);
	});

	test("ships the context-waste proxy section + insight with denominators (warren-6d41)", async () => {
		// Three measured runs (rollup rows AND known context tokens); one
		// pre-rollup run whose 10k tokens sit in NO denominator.
		for (let i = 0; i < 3; i += 1) {
			const runId = await seedRunReturningId(repos, {
				projectId,
				agentName: "claude-code",
				provider: "anthropic",
				model: "sonnet",
				state: "succeeded",
				tokensInput: 800,
				tokensCacheRead: 200,
				startedAt: `2026-05-2${i}T10:00:00.000Z`,
				endedAt: `2026-05-2${i}T10:05:00.000Z`,
			});
			await repos.toolCalls.recordUse({
				runId,
				seq: 1,
				ts: `2026-05-2${i}T10:01:00.000Z`,
				toolName: "Bash",
				command: "bun test",
				filePaths: [],
				toolUseId: `u${i}`,
			});
			await repos.toolCalls.recordResult({
				runId,
				toolUseId: `u${i}`,
				isError: false,
				resultBytes: 600,
			});
		}
		await seedRunReturningId(repos, {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			state: "succeeded",
			tokensInput: 10_000,
			startedAt: "2026-05-25T10:00:00.000Z",
			endedAt: "2026-05-25T10:05:00.000Z",
		});
		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior?${WINDOW}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			contextWaste: {
				runsInWindow: number;
				runsWithRollup: number;
				runsMeasured: number;
				contextTokensTotal: number;
				resultBytesTotal: number;
				share: number | null;
				confidence: string;
				byTool: { key: string; resultBytesTotal: number; share: number | null }[];
				byCommand: { key: string }[];
			};
			insights: { kind: string; subject: string | null; denominator?: number }[];
		};
		expect(body.contextWaste).toMatchObject({
			runsInWindow: 4,
			runsWithRollup: 3,
			runsMeasured: 3,
			contextTokensTotal: 3000,
			resultBytesTotal: 1800,
			confidence: "low",
		});
		expect(body.contextWaste.share).toBeCloseTo(0.6, 5);
		expect(body.contextWaste.byTool[0]).toMatchObject({ key: "Bash", resultBytesTotal: 1800 });
		expect(body.contextWaste.byCommand.map((c) => c.key)).toEqual(["bun test"]);
		const hit = body.insights.find((i) => i.kind === "context-waste-proxy");
		expect(hit).toBeDefined();
		expect(hit?.subject).toBe("Bash");
		expect(hit?.denominator).toBe(3);
	});

	test("rejects malformed ?from (warren-5d50)", async () => {
		start();
		const bad = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior?from=nope`);
		expect(bad.status).toBe(400);
	});
});

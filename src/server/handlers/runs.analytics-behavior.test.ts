import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunState } from "../../db/schema.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function depsFor(repos: Repos): ServerDeps {
	const broker = new RunEventBroker();
	const client = new FakeProvider();
	return {
		repos,
		runtimeProvider: client,
		forge: new FakeForge(),
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			runtimeProvider: client,
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

// warren-ec44: these suites seed runs at fixed 2026-05 dates, so they must
// pin an explicit ?from/?to window rather than rely on the handler's default
// "last 30 days" relative to the system clock (which excludes the data once
// the wall clock advances past it).
const WINDOW = "from=2026-05-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z";
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

	test("rejects malformed ?from (warren-5d50)", async () => {
		start();
		const bad = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior?from=nope`);
		expect(bad.status).toBe(400);
	});

	// warren-8f1b: the per-directory difficulty map joins rollup file
	// paths to run outcomes, path-level retries, and steering counts.
	async function fileCall(
		runId: string,
		seq: number,
		id: string,
		paths: readonly string[],
		isError: boolean,
	): Promise<void> {
		await repos.toolCalls.recordUse({
			runId,
			seq,
			ts: new Date(2026, 4, 20, 11, 0, seq).toISOString(),
			toolName: "Edit",
			command: null,
			filePaths: paths,
			toolUseId: id,
		});
		await repos.toolCalls.recordResult({ runId, toolUseId: id, isError, resultBytes: null });
	}

	test("surfaces the per-directory difficulty map with denominators + confidence (warren-8f1b)", async () => {
		const base: Omit<SeedRunOpts, "state" | "startedAt"> = {
			projectId,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
		};
		const r1 = await seedRunReturningId({
			...base,
			state: "succeeded",
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		const r2 = await seedRunReturningId({
			...base,
			state: "failed",
			failureReason: "crashed",
			startedAt: "2026-05-21T10:00:00.000Z",
			endedAt: "2026-05-21T10:05:00.000Z",
		});
		const r3 = await seedRunReturningId({
			...base,
			state: "failed",
			failureReason: "crashed",
			startedAt: "2026-05-22T10:00:00.000Z",
			endedAt: "2026-05-22T10:05:00.000Z",
		});
		await fileCall(r1, 1, "f1", ["src/server/a.ts"], false);
		await fileCall(r2, 1, "f2", ["src/server/b.ts"], true);
		await fileCall(r2, 2, "f3", ["src/server/b.ts"], false);
		await fileCall(r3, 1, "f4", ["src/server/c.ts"], true);
		await repos.events.append({
			runId: r2,
			sandboxEventSeq: 99,
			ts: "2026-05-21T10:02:00.000Z",
			kind: "steer.sent",
			payload: {},
		});

		start();
		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/analytics/behavior?${WINDOW}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			directories: {
				directories: {
					directory: string;
					runsTouching: number;
					runsFailed: number;
					failureShare: number | null;
					fileTouches: number;
					retries: number;
					steeringMessages: number;
					confidence: string;
				}[];
				totals: { runsInWindow: number; runsWithFilePaths: number };
			};
			insights: { kind: string; subject: string | null; detail: string }[];
		};
		expect(body.directories.totals).toMatchObject({ runsInWindow: 3, runsWithFilePaths: 3 });
		const server = body.directories.directories.find((d) => d.directory === "src/server");
		expect(server).toMatchObject({
			runsTouching: 3,
			runsFailed: 2,
			fileTouches: 4,
			retries: 1,
			steeringMessages: 1,
			confidence: "low",
		});
		expect(server?.failureShare).toBeCloseTo(2 / 3);
		const insight = body.insights.find((i) => i.kind === "hardest-directory");
		expect(insight?.subject).toBe("src/server");
		expect(insight?.detail).toContain("confidence: low");
	});
});

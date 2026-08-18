import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	backfillToolCallRollup,
	DEFAULT_TOOL_CALLS_BACKFILL_MAX_RUNS,
	DEFAULT_TOOL_CALLS_BACKFILL_WINDOW_DAYS,
	repairToolCallRollup,
} from "./tool-calls-backfill.ts";

describe("backfillToolCallRollup", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;
	const NOW = new Date("2026-08-15T00:00:00.000Z");

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	async function seedRun(renderedAgentJson: unknown): Promise<string> {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			renderedAgentJson,
			prompt: "x",
			trigger: "manual",
		});
		return run.id;
	}

	function appendToolEvent(runId: string, seq: number, kind: string, payload: unknown, ts: string) {
		return repos.events.append({ runId, sandboxEventSeq: seq, ts, kind, payload });
	}

	test("re-extracts a pre-rollup run's tool history through the shape registries", async () => {
		const runId = await seedRun({ frontmatter: { runtime: "claude-code" } });
		await appendToolEvent(
			runId,
			1,
			"tool_use",
			{ id: "u1", name: "Bash", input: { command: "bun test" } },
			"2026-08-14T10:00:00.000Z",
		);
		await appendToolEvent(
			runId,
			2,
			"tool_result",
			{ tool_use_id: "u1", is_error: true, content: "boom" },
			"2026-08-14T10:00:01.000Z",
		);
		await appendToolEvent(
			runId,
			3,
			"tool_use",
			{ id: "r1", name: "Read", input: { file_path: "/src/a.ts" } },
			"2026-08-14T10:00:02.000Z",
		);

		const result = await backfillToolCallRollup(repos, { now: () => NOW });
		expect(result).toEqual({ runs: 1, uses: 2, results: 1 });

		const { rows } = await repos.toolCalls.listForRuns([runId]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			seq: 1,
			toolName: "Bash",
			command: "bun test",
			toolUseId: "u1",
			isError: true,
			resultBytes: 4,
		});
		expect(rows[1]).toMatchObject({
			seq: 3,
			toolName: "Read",
			command: null,
			filePaths: ["/src/a.ts"],
			isError: false,
		});
	});

	test("is idempotent — a second pass lands no duplicate rows", async () => {
		const runId = await seedRun({ frontmatter: { runtime: "pi" } });
		await appendToolEvent(
			runId,
			1,
			"tool_use",
			{ toolName: "bash", command: "git status", toolCallId: "c1" },
			"2026-08-14T10:00:00.000Z",
		);
		const first = await backfillToolCallRollup(repos, { now: () => NOW });
		expect(first.uses).toBe(1);
		// The run left the candidate set, so the second pass is a no-op.
		const second = await backfillToolCallRollup(repos, { now: () => NOW });
		expect(second).toEqual({ runs: 0, uses: 0, results: 0 });
		expect(await repos.toolCalls.countByRun(runId)).toBe(1);
	});

	test("skips runs outside the lookback window", async () => {
		const runId = await seedRun({});
		await appendToolEvent(
			runId,
			1,
			"tool_use",
			{ id: "u1", name: "Bash", input: { command: "ls" } },
			"2026-01-01T00:00:00.000Z",
		);
		const result = await backfillToolCallRollup(repos, { now: () => NOW });
		expect(result.runs).toBe(0);
		expect(await repos.toolCalls.countByRun(runId)).toBe(0);
	});

	test("a poisoned run is skipped without stopping the pass", async () => {
		// A run id present in events but whose run row vanished (no FK in
		// this seeded state) must not stop other candidates.
		const ghostId = "aa-ghost-run";
		await appendToolEvent(ghostId, 1, "tool_use", { id: "u1" }, "2026-08-14T10:00:00.000Z").catch(
			() => {},
		);
		const runId = await seedRun({});
		await appendToolEvent(
			runId,
			1,
			"tool_use",
			{ id: "u1", name: "Bash", input: { command: "ls" } },
			"2026-08-14T10:00:00.000Z",
		);
		const result = await backfillToolCallRollup(repos, { now: () => NOW });
		expect(result.runs).toBe(1);
		expect(await repos.toolCalls.countByRun(runId)).toBe(1);
	});

	test("exposes non-blocking defaults (windowed + capped)", () => {
		expect(DEFAULT_TOOL_CALLS_BACKFILL_WINDOW_DAYS).toBe(30);
		expect(DEFAULT_TOOL_CALLS_BACKFILL_MAX_RUNS).toBe(100);
	});

	test("repair re-extracts rows a since-fixed shape mis-read (warren-677c)", async () => {
		const runId = await seedRun({ frontmatter: { runtime: "pi" } });
		// The production pi toolCall shape: args under `arguments`.
		await appendToolEvent(
			runId,
			1,
			"tool_use",
			{ name: "bash", type: "toolCall", id: "c1", arguments: { command: "bun test" } },
			"2026-08-14T10:00:00.000Z",
		);
		await appendToolEvent(
			runId,
			2,
			"tool_use",
			{ name: "read", type: "toolCall", id: "c2", arguments: { path: "AGENTS.md" } },
			"2026-08-14T10:00:01.000Z",
		);
		// Simulate the damage: rollup rows extracted by the pre-fix shape.
		await repos.toolCalls.recordUse({
			runId,
			seq: 1,
			ts: "2026-08-14T10:00:00.000Z",
			toolName: "bash",
			command: null,
			filePaths: [],
			toolUseId: "c1",
		});
		await repos.toolCalls.recordUse({
			runId,
			seq: 2,
			ts: "2026-08-14T10:00:01.000Z",
			toolName: "read",
			command: null,
			filePaths: [],
			toolUseId: "c2",
		});
		// The boot backfill skips the run — it already has rollup rows.
		expect(await backfillToolCallRollup(repos, { now: () => NOW })).toEqual({
			runs: 0,
			uses: 0,
			results: 0,
		});

		const result = await repairToolCallRollup(repos);
		expect(result).toEqual({ runs: 1, skipped: 0, uses: 2, results: 0 });
		const { rows } = await repos.toolCalls.listForRuns([runId]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ seq: 1, toolName: "bash", command: "bun test" });
		expect(rows[1]).toMatchObject({ seq: 2, toolName: "read", filePaths: ["AGENTS.md"] });

		// Idempotent: a second pass rewrites identical rows.
		const again = await repairToolCallRollup(repos);
		expect(again).toEqual({ runs: 1, skipped: 0, uses: 2, results: 0 });
		expect(await repos.toolCalls.countByRun(runId)).toBe(2);
	});

	test("repair keeps stale rollup rows when the run's events are pruned", async () => {
		const runId = await seedRun({ frontmatter: { runtime: "pi" } });
		// Rollup rows exist but the source events do not — never delete.
		await repos.toolCalls.recordUse({
			runId,
			seq: 1,
			ts: "2026-08-14T10:00:00.000Z",
			toolName: "bash",
			command: null,
			filePaths: [],
			toolUseId: "c1",
		});
		const result = await repairToolCallRollup(repos);
		expect(result).toEqual({ runs: 0, skipped: 1, uses: 0, results: 0 });
		expect(await repos.toolCalls.countByRun(runId)).toBe(1);
	});

	test("repair pages across runs and replays result joins", async () => {
		const runA = await seedRun({ frontmatter: { runtime: "pi" } });
		const runB = await seedRun({ frontmatter: { runtime: "pi" } });
		for (const runId of [runA, runB]) {
			await appendToolEvent(
				runId,
				1,
				"tool_use",
				{ name: "bash", type: "toolCall", id: "c1", arguments: { command: "git status" } },
				"2026-08-14T10:00:00.000Z",
			);
			await appendToolEvent(
				runId,
				2,
				"tool_result",
				{ toolCallId: "c1", isError: false, output: "clean" },
				"2026-08-14T10:00:01.000Z",
			);
			await repos.toolCalls.recordUse({
				runId,
				seq: 1,
				ts: "2026-08-14T10:00:00.000Z",
				toolName: "bash",
				command: null,
				filePaths: [],
				toolUseId: "c1",
			});
		}
		const result = await repairToolCallRollup(repos, { pageSize: 1 });
		expect(result).toEqual({ runs: 2, skipped: 0, uses: 2, results: 2 });
		for (const runId of [runA, runB]) {
			const { rows } = await repos.toolCalls.listForRuns([runId]);
			expect(rows[0]).toMatchObject({ command: "git status", isError: false, resultBytes: 5 });
		}
	});
});

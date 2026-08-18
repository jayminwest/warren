import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";
import { ToolCallsRepo } from "./tool-calls.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`ToolCallsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const runs = new RunsRepo(adapter);
			const events = new EventsRepo(adapter);
			const toolCalls = new ToolCallsRepo(adapter);
			await agents.upsert({ name: "refactor-bot", renderedJson: {} });
			const project = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			const run = await runs.create({
				agentName: "refactor-bot",
				projectId: project.id,
				renderedAgentJson: {},
				prompt: "x",
				trigger: "manual",
			});
			return { handle, events, toolCalls, projects, projectId: project.id, runId: run.id };
		};

		test("recordUse inserts a structured row; recordResult joins by (runId, toolUseId)", async () => {
			const { handle, toolCalls, runId } = await open();
			try {
				await toolCalls.recordUse({
					runId,
					seq: 1,
					ts: "2026-08-01T00:00:00.000Z",
					toolName: "Bash",
					command: "bun test",
					filePaths: [],
					toolUseId: "u1",
				});
				await toolCalls.recordResult({
					runId,
					toolUseId: "u1",
					isError: true,
					resultBytes: 42,
				});
				const { rows, truncated } = await toolCalls.listForRuns([runId]);
				expect(truncated).toBe(false);
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					runId,
					seq: 1,
					toolName: "Bash",
					command: "bun test",
					toolUseId: "u1",
					isError: true,
					resultBytes: 42,
				});
			} finally {
				await handle.close();
			}
		});

		test("recordUse is idempotent on (run_id, seq) — backfill/bridge races land no dupes", async () => {
			const { handle, toolCalls, runId } = await open();
			try {
				const row = {
					runId,
					seq: 1,
					ts: "2026-08-01T00:00:00.000Z",
					toolName: "Bash",
					command: "ls",
					filePaths: [] as readonly string[],
					toolUseId: "u1",
				};
				await toolCalls.recordUse(row);
				await toolCalls.recordUse(row);
				expect(await toolCalls.countByRun(runId)).toBe(1);
			} finally {
				await handle.close();
			}
		});

		test("recordResult with an unmatched toolUseId updates nothing", async () => {
			const { handle, toolCalls, runId } = await open();
			try {
				await toolCalls.recordUse({
					runId,
					seq: 1,
					ts: "2026-08-01T00:00:00.000Z",
					toolName: "Bash",
					command: "ls",
					filePaths: [],
					toolUseId: "u1",
				});
				await toolCalls.recordResult({
					runId,
					toolUseId: "nope",
					isError: true,
					resultBytes: 1,
				});
				const { rows } = await toolCalls.listForRuns([runId]);
				expect(rows[0]).toMatchObject({ isError: false, resultBytes: null });
			} finally {
				await handle.close();
			}
		});

		test("listForRuns orders by (runId, seq) and reports truncation", async () => {
			const { handle, toolCalls, runId } = await open();
			try {
				for (let seq = 1; seq <= 4; seq++) {
					await toolCalls.recordUse({
						runId,
						seq,
						ts: "2026-08-01T00:00:00.000Z",
						toolName: "Bash",
						command: `cmd${seq}`,
						filePaths: [],
						toolUseId: null,
					});
				}
				const capped = await toolCalls.listForRuns([runId], { limit: 3 });
				expect(capped.truncated).toBe(true);
				expect(capped.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
				const full = await toolCalls.listForRuns([runId], { limit: 4 });
				expect(full.truncated).toBe(false);
				expect(full.rows).toHaveLength(4);
				// Empty runIds short-circuits.
				expect(await toolCalls.listForRuns([])).toEqual({ rows: [], truncated: false });
			} finally {
				await handle.close();
			}
		});

		test("listRunsMissingRollup returns runs with recent tool events but no rollup rows", async () => {
			const { handle, events, toolCalls, runId } = await open();
			try {
				await events.append({
					runId,
					sandboxEventSeq: 1,
					ts: "2026-08-10T00:00:00.000Z",
					kind: "tool_use",
					payload: {},
				});
				// Outside the window — not a candidate.
				expect(
					await toolCalls.listRunsMissingRollup({ sinceTs: "2026-08-11T00:00:00.000Z", limit: 10 }),
				).toEqual([]);
				// Inside the window, no rollup rows — candidate.
				expect(
					await toolCalls.listRunsMissingRollup({ sinceTs: "2026-08-01T00:00:00.000Z", limit: 10 }),
				).toEqual([runId]);
				// Rollup row landed — leaves the candidate set.
				await toolCalls.recordUse({
					runId,
					seq: 1,
					ts: "2026-08-10T00:00:00.000Z",
					toolName: null,
					command: null,
					filePaths: [],
					toolUseId: null,
				});
				expect(
					await toolCalls.listRunsMissingRollup({ sinceTs: "2026-08-01T00:00:00.000Z", limit: 10 }),
				).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("listRunsWithRollup pages runs that HAVE rollup rows; deleteForRun empties one run", async () => {
			const { handle, toolCalls, runId } = await open();
			try {
				// No rollup rows yet — not a repair candidate.
				expect(await toolCalls.listRunsWithRollup({ limit: 10 })).toEqual([]);
				await toolCalls.recordUse({
					runId,
					seq: 1,
					ts: "2026-08-10T00:00:00.000Z",
					toolName: "bash",
					command: null,
					filePaths: [],
					toolUseId: "c1",
				});
				await toolCalls.recordUse({
					runId,
					seq: 2,
					ts: "2026-08-10T00:00:01.000Z",
					toolName: "read",
					command: null,
					filePaths: [],
					toolUseId: "c2",
				});
				expect(await toolCalls.listRunsWithRollup({ limit: 10 })).toEqual([runId]);
				// Keyset pagination: everything after the last-seen run id.
				expect(await toolCalls.listRunsWithRollup({ limit: 10, afterRunId: runId })).toEqual([]);
				await toolCalls.deleteForRun(runId);
				expect(await toolCalls.countByRun(runId)).toBe(0);
				expect(await toolCalls.listRunsWithRollup({ limit: 10 })).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("rollup rows cascade on project delete like the events transcript", async () => {
			const { handle, toolCalls, projects, projectId, runId } = await open();
			try {
				await toolCalls.recordUse({
					runId,
					seq: 1,
					ts: "2026-08-01T00:00:00.000Z",
					toolName: "Bash",
					command: "ls",
					filePaths: [],
					toolUseId: null,
				});
				expect(await toolCalls.countByRun(runId)).toBe(1);
				await projects.delete(projectId);
				expect(await toolCalls.countByRun(runId)).toBe(0);
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) {
	suite("postgres");
}

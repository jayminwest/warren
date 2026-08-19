import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DispatchContextRepo } from "./dispatch-context.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`DispatchContextRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const runs = new RunsRepo(adapter);
			const dispatchContext = new DispatchContextRepo(adapter);
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
			return { handle, dispatchContext, runId: run.id };
		};

		test("insert writes a fact row; getByRunId returns it", async () => {
			const { handle, dispatchContext, runId } = await open();
			try {
				const row = await dispatchContext.insert({
					runId,
					createdAt: "2026-08-18T00:00:00.000Z",
					agentName: "refactor-bot",
					provider: "anthropic",
					model: "claude-sonnet-4",
					providerSource: "override",
					modelSource: "frontmatter",
					capSource: "project_default",
					maxCostUsd: 1.5,
					runtimeId: "pi",
					runtimeBackend: "local",
					promptBytes: 42,
					mode: "batch",
					network: "restricted",
					queueQueuedRuns: 0,
					queueRunningRuns: 1,
					queueProjectNonTerminal: 1,
					queueSnapshotSource: "runs_table",
					trigger: "manual",
					dispatchOrigin: "api",
					dispatcherHandle: "operator",
					triggerId: null,
					planRunId: null,
					retryKind: "none",
					retryOfRunId: null,
					parentRunId: null,
					attemptNo: 1,
					rootRunId: runId,
					seedId: "warren-36e7",
					seedStatus: "in_progress",
					seedPriority: 1,
					seedSize: "m",
				});
				if (row === null) throw new Error("expected insert to land");
				expect(row).toMatchObject({
					runId,
					agentName: "refactor-bot",
					providerSource: "override",
					retryKind: "none",
					queueSnapshotSource: "runs_table",
					seedId: "warren-36e7",
				});
				const fetched = await dispatchContext.getByRunId(runId);
				expect(fetched).toEqual(row);
			} finally {
				await handle.close();
			}
		});

		test("insert is idempotent on run_id — second insert returns null", async () => {
			const { handle, dispatchContext, runId } = await open();
			try {
				const input = {
					runId,
					createdAt: "2026-08-18T00:00:00.000Z",
					agentName: "refactor-bot",
				};
				expect(await dispatchContext.insert(input)).not.toBeNull();
				expect(await dispatchContext.insert({ ...input, agentName: "other" })).toBeNull();
				const fetched = await dispatchContext.getByRunId(runId);
				expect(fetched?.agentName).toBe("refactor-bot");
			} finally {
				await handle.close();
			}
		});

		test("NULL columns stay null — unknown is not folded into a bucket", async () => {
			const { handle, dispatchContext, runId } = await open();
			try {
				const row = await dispatchContext.insert({
					runId,
					createdAt: "2026-08-18T00:00:00.000Z",
				});
				expect(row).toMatchObject({
					runId,
					provider: null,
					providerSource: null,
					maxCostUsd: null,
					queueQueuedRuns: null,
					retryKind: null,
					seedId: null,
				});
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) suite("postgres");

import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";
import { aggregateRunCost, countNonTerminal, countRunsByState } from "./runs-stats.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`runs-stats (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const repo = new RunsRepo(adapter);
			const a = await agents.upsert({ name: "refactor-bot", renderedJson: { sections: {} } });
			const p = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			return { handle, adapter, repo, agents, projects, agentName: a.name, projectId: p.id };
		};

		const spawn = (repo: RunsRepo, agentName: string, projectId: string) =>
			repo.create({
				agentName,
				projectId,
				prompt: "fix the flaky test",
				renderedAgentJson: { sections: {} },
				trigger: "manual",
			});

		test("countRunsByState returns a dense per-state record", async () => {
			const { handle, adapter, repo, agentName, projectId } = await open();
			try {
				const a = await spawn(repo, agentName, projectId);
				await spawn(repo, agentName, projectId);
				await repo.markRunning(a.id);
				const counts = await countRunsByState(adapter);
				expect(counts.queued).toBe(1);
				expect(counts.running).toBe(1);
				expect(counts.succeeded).toBe(0);
				expect(counts.failed).toBe(0);
				expect(counts.cancelled).toBe(0);
			} finally {
				await handle.close();
			}
		});

		test("countNonTerminal counts queued+running across the instance", async () => {
			const { handle, adapter, repo, agentName, projectId } = await open();
			try {
				expect(await countNonTerminal(adapter)).toBe(0);
				const a = await spawn(repo, agentName, projectId);
				await spawn(repo, agentName, projectId);
				await repo.markRunning(a.id);
				const done = await spawn(repo, agentName, projectId);
				await repo.markRunning(done.id);
				await repo.finalize(done.id, "succeeded");
				// 1 running + 1 queued; the succeeded row is excluded.
				expect(await countNonTerminal(adapter)).toBe(2);
				expect(await repo.countNonTerminal()).toBe(2);
			} finally {
				await handle.close();
			}
		});

		test("countNonTerminal scopes to a project when projectId is set", async () => {
			const { handle, adapter, repo, agentName, projectId, projects } = await open();
			try {
				const other = await projects.create({
					gitUrl: "https://github.com/x/z.git",
					localPath: "/data/projects/x/z",
					defaultBranch: "main",
				});
				await spawn(repo, agentName, projectId);
				await spawn(repo, agentName, projectId);
				const otherRun = await spawn(repo, agentName, other.id);
				await repo.markRunning(otherRun.id);
				expect(await countNonTerminal(adapter)).toBe(3);
				expect(await countNonTerminal(adapter, projectId)).toBe(2);
				expect(await countNonTerminal(adapter, other.id)).toBe(1);
				expect(await repo.countNonTerminal(projectId)).toBe(2);
				expect(await repo.countNonTerminal(other.id)).toBe(1);
			} finally {
				await handle.close();
			}
		});

		test("aggregateRunCost sums cost + tokens, coalescing nulls to zero", async () => {
			const { handle, adapter, repo, agentName, projectId } = await open();
			try {
				const empty = await aggregateRunCost(adapter);
				expect(empty).toEqual({ costUsd: 0, tokensInput: 0, tokensOutput: 0 });
				const a = await spawn(repo, agentName, projectId);
				const b = await spawn(repo, agentName, projectId);
				await spawn(repo, agentName, projectId); // null cost — coalesced
				await repo.attachStats(a.id, { costUsd: 0.25, tokensInput: 100, tokensOutput: 40 });
				await repo.attachStats(b.id, { costUsd: 0.75, tokensInput: 200, tokensOutput: 60 });
				const agg = await aggregateRunCost(adapter);
				expect(agg.costUsd).toBeCloseTo(1.0);
				expect(agg.tokensInput).toBe(300);
				expect(agg.tokensOutput).toBe(100);
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

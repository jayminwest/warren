/**
 * RunsRepo.updateUsage write-through for the usage hydrator (warren-b33e).
 * Split from runs.test.ts to stay under that file's frozen size budget.
 */

import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`RunsRepo.updateUsage (${dialect})`, () => {
		test("persists derived cost + token totals wholesale", async () => {
			const handle = await withDb({ dialect });
			try {
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
				const row = await repo.create({
					agentName: a.name,
					projectId: p.id,
					prompt: "fix the flaky test",
					renderedAgentJson: { sections: {} },
					trigger: "manual",
				});
				await repo.updateUsage(row.id, {
					costUsd: 0.314,
					tokensInput: 900,
					tokensOutput: 120,
					tokensCacheRead: 45,
					tokensCacheWrite: 7,
				});
				const reread = await repo.require(row.id);
				expect(reread.costUsd).toBeCloseTo(0.314);
				expect(reread.tokensInput).toBe(900);
				expect(reread.tokensOutput).toBe(120);
				expect(reread.tokensCacheRead).toBe(45);
				expect(reread.tokensCacheWrite).toBe(7);
				// Zero-envelope write lands too, so the row stops hydrating.
				const other = await repo.create({
					agentName: a.name,
					projectId: p.id,
					prompt: "fix the flaky test",
					renderedAgentJson: { sections: {} },
					trigger: "manual",
				});
				await repo.updateUsage(other.id, {
					costUsd: 0,
					tokensInput: 0,
					tokensOutput: 0,
					tokensCacheRead: 0,
					tokensCacheWrite: 0,
				});
				const zeroed = await repo.require(other.id);
				expect(zeroed.costUsd).toBe(0);
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

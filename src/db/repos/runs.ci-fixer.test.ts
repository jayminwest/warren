import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`RunsRepo CI-fixer queries (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const repo = new RunsRepo(adapter);
			const a = await new AgentsRepo(adapter).upsert({
				name: "refactor-bot",
				renderedJson: { sections: {} },
			});
			const p = await new ProjectsRepo(adapter).create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			return { handle, repo, agentName: a.name, projectId: p.id };
		};

		function spawn(
			repo: RunsRepo,
			agentName: string,
			projectId: string,
			extra: Partial<Parameters<RunsRepo["create"]>[0]> = {},
		) {
			return repo.create({
				agentName,
				projectId,
				prompt: "fix the flaky test",
				renderedAgentJson: { sections: {} },
				trigger: "manual",
				...extra,
			});
		}

		test("listPrCandidatesByProject de-dupes by pr_url to the oldest opener, newest PR first", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const opener1 = await spawn(repo, agentName, projectId);
				const fixer1 = await spawn(repo, agentName, projectId, { trigger: "ci-fixer" });
				const opener2 = await spawn(repo, agentName, projectId);
				await spawn(repo, agentName, projectId); // no PR — excluded
				await repo.markRunning(opener1.id, new Date("2026-01-01T00:00:00.000Z"));
				await repo.markRunning(fixer1.id, new Date("2026-01-01T01:00:00.000Z"));
				await repo.markRunning(opener2.id, new Date("2026-01-01T02:00:00.000Z"));
				await repo.setPrUrl(opener1.id, "https://github.com/x/y/pull/1");
				await repo.setPrUrl(fixer1.id, "https://github.com/x/y/pull/1");
				await repo.setPrUrl(opener2.id, "https://github.com/x/y/pull/2");

				const candidates = await repo.listPrCandidatesByProject(projectId);
				expect(candidates).toEqual([
					{ runId: opener2.id, prUrl: "https://github.com/x/y/pull/2" },
					{ runId: opener1.id, prUrl: "https://github.com/x/y/pull/1" },
				]);
				expect(await repo.listPrCandidatesByProject(projectId, 1)).toEqual([
					{ runId: opener2.id, prUrl: "https://github.com/x/y/pull/2" },
				]);
			} finally {
				await handle.close();
			}
		});

		test("fixAttemptHistoryByPrUrl counts ci-fixer runs and reports the latest completion", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const prUrl = "https://github.com/x/y/pull/7";
				const opener = await spawn(repo, agentName, projectId);
				await repo.setPrUrl(opener.id, prUrl);
				expect(await repo.fixAttemptHistoryByPrUrl(prUrl)).toEqual({
					attempts: 0,
					lastAttemptAt: null,
				});

				const fixerA = await spawn(repo, agentName, projectId, { trigger: "ci-fixer" });
				await repo.setPrUrl(fixerA.id, prUrl);
				await repo.markRunning(fixerA.id, new Date("2026-02-01T00:00:00.000Z"));
				await repo.finalize(fixerA.id, "failed", new Date("2026-02-01T00:10:00.000Z"));
				const fixerB = await spawn(repo, agentName, projectId, { trigger: "ci-fixer" });
				await repo.setPrUrl(fixerB.id, prUrl);
				await repo.markRunning(fixerB.id, new Date("2026-02-01T01:00:00.000Z"));
				await repo.finalize(fixerB.id, "succeeded", new Date("2026-02-01T01:20:00.000Z"));

				expect(await repo.fixAttemptHistoryByPrUrl(prUrl)).toEqual({
					attempts: 2,
					lastAttemptAt: "2026-02-01T01:20:00.000Z",
				});
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

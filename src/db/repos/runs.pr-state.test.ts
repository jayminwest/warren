/**
 * Merge-watcher PR facts on runs (warren-3bc6 / pl-103e step 6):
 * `setPrState` persistence + `listWithUnresolvedPr` re-adoption query.
 * Split out of runs.test.ts to keep that file under its frozen size
 * budget; mirrors its dual-dialect suite shape.
 */
import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`RunsRepo PR facts (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const repo = new RunsRepo(adapter);
			await agents.upsert({ name: "refactor-bot", renderedJson: { sections: {} } });
			const p = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			return { handle, repo, agentName: "refactor-bot", projectId: p.id };
		};

		function spawn(repo: RunsRepo, agentName: string, projectId: string) {
			return repo.create({
				agentName,
				projectId,
				prompt: "fix the flaky test",
				renderedAgentJson: { sections: {} },
				trigger: "manual",
			});
		}

		test("setPrState persists the merge-watcher facts and listWithUnresolvedPr filters", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const noPr = await spawn(repo, agentName, projectId);
				const unset = await spawn(repo, agentName, projectId);
				await repo.setPrUrl(unset.id, "https://github.com/x/y/pull/1");
				const open = await spawn(repo, agentName, projectId);
				await repo.setPrUrl(open.id, "https://github.com/x/y/pull/2");
				await repo.setPrState(open.id, "open", null);
				const merged = await spawn(repo, agentName, projectId);
				await repo.setPrUrl(merged.id, "https://github.com/x/y/pull/3");
				const settled = await repo.setPrState(merged.id, "merged", "2026-08-14T00:00:00.000Z");
				expect(settled.prState).toBe("merged");
				expect(settled.prMergedAt).toBe("2026-08-14T00:00:00.000Z");
				expect((await repo.get(merged.id))?.prState).toBe("merged");

				// Unresolved = pr_url set AND pr_state NULL-or-open.
				expect((await repo.listWithUnresolvedPr()).map((r) => r.id).sort()).toEqual(
					[unset.id, open.id].sort(),
				);
				expect((await repo.listWithUnresolvedPr()).map((r) => r.id)).not.toContain(noPr.id);
			} finally {
				await handle.close();
			}
		});

		test("setPrState last write wins and clears prMergedAt for non-merged states", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const run = await spawn(repo, agentName, projectId);
				await repo.setPrState(run.id, "open", null);
				const closed = await repo.setPrState(run.id, "closed_unmerged", null);
				expect(closed.prState).toBe("closed_unmerged");
				expect(closed.prMergedAt).toBeNull();
				expect(await repo.listWithUnresolvedPr()).toEqual([]);
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

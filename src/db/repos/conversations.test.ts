import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { ConversationsRepo } from "./conversations.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`ConversationsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const projects = new ProjectsRepo(adapter);
			const repo = new ConversationsRepo(adapter);
			const project = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			return { handle, repo, projects, projectId: project.id };
		};

		test("create mints a conv-prefixed id and defaults to active", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const row = await repo.create({
					projectId,
					plotId: "plot-abc123",
					anchoringRunId: "run_aaa",
					title: "Shape the intent",
				});
				expect(row.id.startsWith("conv_")).toBe(true);
				expect(row.status).toBe("active");
				expect(row.plotId).toBe("plot-abc123");
				expect(row.closedAt).toBeNull();
				expect(row.lastActivityAt).toBe(row.createdAt);
				const got = await repo.get(row.id);
				expect(got?.anchoringRunId).toBe("run_aaa");
			} finally {
				await handle.close();
			}
		});

		test("require throws NotFoundError for an unknown id", async () => {
			const { handle, repo } = await open();
			try {
				await expect(repo.require("conv_missing")).rejects.toBeInstanceOf(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("listByProject orders most-recent-activity first and filters by status", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const a = await repo.create({
					projectId,
					now: new Date("2026-06-01T00:00:00.000Z"),
				});
				const b = await repo.create({
					projectId,
					now: new Date("2026-06-02T00:00:00.000Z"),
				});
				await repo.close(b.id, new Date("2026-06-03T00:00:00.000Z"));
				const all = await repo.listByProject(projectId);
				expect(all.map((r) => r.id)).toEqual([b.id, a.id]);
				const active = await repo.listByProject(projectId, "active");
				expect(active.map((r) => r.id)).toEqual([a.id]);
				const closed = await repo.listByProject(projectId, "closed");
				expect(closed.map((r) => r.id)).toEqual([b.id]);
			} finally {
				await handle.close();
			}
		});

		test("listAll returns every conversation, most-recent-activity first", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const a = await repo.create({ projectId, now: new Date("2026-06-01T00:00:00.000Z") });
				const b = await repo.create({ projectId, now: new Date("2026-06-02T00:00:00.000Z") });
				const all = await repo.listAll();
				expect(all.map((r) => r.id)).toEqual([b.id, a.id]);
			} finally {
				await handle.close();
			}
		});

		test("listByPlotId returns the N conversations bound to a Plot", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const a = await repo.create({ projectId, plotId: "plot-x" });
				const b = await repo.create({ projectId, plotId: "plot-x" });
				await repo.create({ projectId, plotId: "plot-y" });
				const rows = await repo.listByPlotId("plot-x");
				expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
			} finally {
				await handle.close();
			}
		});

		test("rotateAnchor repoints the live run and stamps activity", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const c = await repo.create({
					projectId,
					anchoringRunId: "run_old",
					now: new Date("2026-06-01T00:00:00.000Z"),
				});
				const rotated = await repo.rotateAnchor(
					c.id,
					"run_new",
					new Date("2026-06-05T00:00:00.000Z"),
				);
				expect(rotated.anchoringRunId).toBe("run_new");
				expect(rotated.lastActivityAt).toBe("2026-06-05T00:00:00.000Z");
			} finally {
				await handle.close();
			}
		});

		test("close is idempotent and one-way", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const c = await repo.create({ projectId });
				const closed = await repo.close(c.id, new Date("2026-06-05T00:00:00.000Z"));
				expect(closed.status).toBe("closed");
				expect(closed.closedAt).toBe("2026-06-05T00:00:00.000Z");
				const again = await repo.close(c.id, new Date("2026-06-09T00:00:00.000Z"));
				expect(again.closedAt).toBe("2026-06-05T00:00:00.000Z");
			} finally {
				await handle.close();
			}
		});

		test("recordSubmission stamps the PR ref + planner agent and closes", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const c = await repo.create({ projectId, plotId: "plot-abc" });
				const sent = await repo.recordSubmission(
					c.id,
					{
						prUrl: "https://github.com/x/y/pull/7",
						prNumber: 7,
						plannerAgent: "claude-code",
					},
					new Date("2026-06-06T00:00:00.000Z"),
				);
				expect(sent.status).toBe("closed");
				expect(sent.closedAt).toBe("2026-06-06T00:00:00.000Z");
				expect(sent.submittedPrUrl).toBe("https://github.com/x/y/pull/7");
				expect(sent.submittedPrNumber).toBe(7);
				expect(sent.plannerAgent).toBe("claude-code");
			} finally {
				await handle.close();
			}
		});

		test("deleting the owning project orphans (not deletes) its conversations", async () => {
			const { handle, repo, projects, projectId } = await open();
			try {
				const c = await repo.create({ projectId });
				await projects.delete(projectId);
				const got = await repo.get(c.id);
				expect(got).not.toBeNull();
				expect(got?.projectId).toBeNull();
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

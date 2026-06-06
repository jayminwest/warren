import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { PlotsRepo } from "./plots.ts";
import { ProjectsRepo } from "./projects.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`PlotsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const projects = new ProjectsRepo(adapter);
			const repo = new PlotsRepo(adapter);
			const project = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			return { handle, repo, projects, projectId: project.id };
		};

		test("upsert inserts a new projection row with the full state blob", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const row = await repo.upsert({
					id: "plot-abc123",
					projectId,
					status: "open",
					title: "Ship the thing",
					state: { id: "plot-abc123", sections: { intent: { title: "Ship the thing" } } },
					updatedAt: "2026-06-01T00:00:00.000Z",
				});
				expect(row.id).toBe("plot-abc123");
				expect(row.title).toBe("Ship the thing");
				expect(row.updatedAt).toBe("2026-06-01T00:00:00.000Z");
				const got = await repo.get("plot-abc123");
				expect(got?.status).toBe("open");
				expect(got?.stateJson).toEqual({
					id: "plot-abc123",
					sections: { intent: { title: "Ship the thing" } },
				});
			} finally {
				await handle.close();
			}
		});

		test("upsert is idempotent last-writer-wins on the same id", async () => {
			const { handle, repo, projectId } = await open();
			try {
				await repo.upsert({
					id: "plot-dup",
					projectId,
					status: "open",
					title: "First",
					state: { v: 1 },
					updatedAt: "2026-06-01T00:00:00.000Z",
				});
				const second = await repo.upsert({
					id: "plot-dup",
					projectId,
					status: "done",
					title: "Second",
					state: { v: 2 },
					updatedAt: "2026-06-02T00:00:00.000Z",
				});
				expect(second.status).toBe("done");
				const got = await repo.get("plot-dup");
				expect(got?.title).toBe("Second");
				expect(got?.stateJson).toEqual({ v: 2 });
				expect((await repo.listAll()).length).toBe(1);
			} finally {
				await handle.close();
			}
		});

		test("upsert defaults title to null and updatedAt to now", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const now = new Date("2026-06-03T12:00:00.000Z");
				const row = await repo.upsert({
					id: "plot-notitle",
					projectId,
					status: "open",
					state: {},
					now,
				});
				expect(row.title).toBeNull();
				expect(row.updatedAt).toBe(now.toISOString());
			} finally {
				await handle.close();
			}
		});

		test("get returns null and require throws for an unknown id", async () => {
			const { handle, repo } = await open();
			try {
				expect(await repo.get("plot-missing")).toBeNull();
				expect(repo.require("plot-missing")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("listByProject orders by updatedAt desc and filters by status", async () => {
			const { handle, repo, projectId } = await open();
			try {
				await repo.upsert({
					id: "plot-old",
					projectId,
					status: "done",
					state: {},
					updatedAt: "2026-06-01T00:00:00.000Z",
				});
				await repo.upsert({
					id: "plot-new",
					projectId,
					status: "open",
					state: {},
					updatedAt: "2026-06-05T00:00:00.000Z",
				});
				const all = await repo.listByProject(projectId);
				expect(all.map((r) => r.id)).toEqual(["plot-new", "plot-old"]);
				const open = await repo.listByProject(projectId, "open");
				expect(open.map((r) => r.id)).toEqual(["plot-new"]);
			} finally {
				await handle.close();
			}
		});

		test("listByProject scopes to the given project", async () => {
			const { handle, repo, projects, projectId } = await open();
			try {
				const other = await projects.create({
					gitUrl: "https://github.com/x/z.git",
					localPath: "/data/projects/x/z",
					defaultBranch: "main",
				});
				await repo.upsert({ id: "plot-a", projectId, status: "open", state: {} });
				await repo.upsert({ id: "plot-b", projectId: other.id, status: "open", state: {} });
				expect((await repo.listByProject(projectId)).map((r) => r.id)).toEqual(["plot-a"]);
			} finally {
				await handle.close();
			}
		});

		test("delete removes the row", async () => {
			const { handle, repo, projectId } = await open();
			try {
				await repo.upsert({ id: "plot-del", projectId, status: "open", state: {} });
				await repo.delete("plot-del");
				expect(await repo.get("plot-del")).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("deleting the owning project cascades the projection rows away", async () => {
			const { handle, repo, projects, projectId } = await open();
			try {
				await repo.upsert({ id: "plot-cascade", projectId, status: "open", state: {} });
				await projects.delete(projectId);
				expect(await repo.get("plot-cascade")).toBeNull();
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

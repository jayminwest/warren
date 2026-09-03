import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

/**
 * `RunsRepo.setOutcomeFacts` (warren-ab2b / pl-103e): the reap-time outcome
 * facts round-trip, NULL means unknown, and a missing row surfaces
 * NotFoundError. sqlite-only; the dialect split is exercised by the
 * RunsRepo suite in runs.test.ts.
 */
describe("RunsRepo.setOutcomeFacts (warren-ab2b)", () => {
	const open = async () => {
		const handle = await withDb({ dialect: "sqlite" });
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
		const run = await repo.create({
			agentName: a.name,
			projectId: p.id,
			prompt: "do the thing",
			trigger: "manual",
			renderedAgentJson: {},
		});
		return { handle, repo, run };
	};

	test("fresh rows read NULL (unknown), never zero", async () => {
		const { handle, run } = await open();
		try {
			expect(run.commitsAhead).toBeNull();
			expect(run.filesChanged).toBeNull();
			expect(run.insertions).toBeNull();
			expect(run.deletions).toBeNull();
		} finally {
			await handle.db.close();
		}
	});

	test("persists the measured facts and re-reads them", async () => {
		const { handle, repo, run } = await open();
		try {
			const updated = await repo.setOutcomeFacts(run.id, {
				commitsAhead: 2,
				baseSha: null,
				filesChanged: 3,
				insertions: 40,
				deletions: 7,
			});
			expect(updated.commitsAhead).toBe(2);
			expect(updated.filesChanged).toBe(3);
			expect(updated.insertions).toBe(40);
			expect(updated.deletions).toBe(7);
			const reread = await repo.require(run.id);
			expect(reread.commitsAhead).toBe(2);
			expect(reread.filesChanged).toBe(3);
			expect(reread.insertions).toBe(40);
			expect(reread.deletions).toBe(7);
		} finally {
			await handle.db.close();
		}
	});

	test("records known zeros (empty push) distinctly from unknown NULLs", async () => {
		const { handle, repo, run } = await open();
		try {
			await repo.setOutcomeFacts(run.id, {
				commitsAhead: 0,
				baseSha: null,
				filesChanged: 0,
				insertions: 0,
				deletions: 0,
			});
			const reread = await repo.require(run.id);
			expect(reread.commitsAhead).toBe(0);
			expect(reread.filesChanged).toBe(0);
		} finally {
			await handle.db.close();
		}
	});

	test("a partially-unknown measurement keeps its NULLs", async () => {
		const { handle, repo, run } = await open();
		try {
			await repo.setOutcomeFacts(run.id, {
				commitsAhead: 1,
				baseSha: null,
				filesChanged: null,
				insertions: null,
				deletions: null,
			});
			const reread = await repo.require(run.id);
			expect(reread.commitsAhead).toBe(1);
			expect(reread.filesChanged).toBeNull();
			expect(reread.deletions).toBeNull();
		} finally {
			await handle.db.close();
		}
	});

	test("missing run surfaces NotFoundError", async () => {
		const { handle, repo } = await open();
		try {
			await expect(
				repo.setOutcomeFacts("run-missing", {
					commitsAhead: 1,
					baseSha: null,
					filesChanged: 1,
					insertions: 1,
					deletions: 1,
				}),
			).rejects.toThrow(NotFoundError);
		} finally {
			await handle.db.close();
		}
	});
});

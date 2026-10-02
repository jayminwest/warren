import { describe, expect, test } from "bun:test";
import { withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

describe("countNonTerminalAutomatic", () => {
	test("counts only queued/running scheduler runs, not manual runs", async () => {
		const handle = await withDb({ dialect: "sqlite" });
		try {
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const runs = new RunsRepo(adapter);
			const agent = await agents.upsert({ name: "test-agent", renderedJson: { sections: {} } });
			const project = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			const create = (trigger: string) =>
				runs.create({
					agentName: agent.name,
					projectId: project.id,
					prompt: "test",
					renderedAgentJson: {},
					trigger,
				});

			const cron = await create("cron");
			const scheduled = await create("scheduled");
			const fixer = await create("ci-fixer");
			const plan = await create("plan-run");
			await create("manual");
			expect(await runs.countNonTerminalAutomatic()).toBe(4);

			await runs.markRunning(cron.id);
			await runs.finalize(cron.id, "succeeded");
			expect(await runs.countNonTerminalAutomatic()).toBe(3);
			expect((await runs.require(scheduled.id)).state).toBe("queued");
			expect((await runs.require(fixer.id)).state).toBe("queued");
			expect((await runs.require(plan.id)).state).toBe("queued");
		} finally {
			await handle.close();
		}
	});
});

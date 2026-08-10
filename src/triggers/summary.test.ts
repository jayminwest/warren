import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { TriggersRepo } from "../db/repos/triggers.ts";
import type { CronTrigger } from "../warren-config/schema.ts";
import { buildTriggerSummaries } from "./summary.ts";

async function makeRepo(): Promise<{
	repo: TriggersRepo;
	projectId: string;
	close: () => Promise<void>;
}> {
	const db = await openDatabase({ path: ":memory:" });
	const adapter = DrizzleAdapter.for(db);
	const projects = new ProjectsRepo(adapter);
	const repo = new TriggersRepo(adapter);
	const p = await projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	return { repo, projectId: p.id, close: () => db.close() };
}

const NIGHTLY: CronTrigger = {
	id: "nightly",
	kind: "cron",
	cron: "0 2 * * *",
	seed: "warren-1",
	role: "refactor-bot",
};

describe("buildTriggerSummaries", () => {
	test("carries the entry's maxCostUsd through the summary (warren-a63d)", async () => {
		const { repo, projectId, close } = await makeRepo();
		try {
			const summaries = await buildTriggerSummaries({
				projectId,
				triggers: [{ ...NIGHTLY, maxCostUsd: 5 }, NIGHTLY],
				repo,
				now: new Date("2026-05-10T12:00:00.000Z"),
			});
			expect(summaries[0]?.maxCostUsd).toBe(5);
			// Uncapped entries omit the key rather than carrying undefined.
			expect(Object.keys(summaries[1] ?? {})).not.toContain("maxCostUsd");
		} finally {
			await close();
		}
	});

	test("computes nextFireAt fresh from croner when the expression parses", async () => {
		const { repo, projectId, close } = await makeRepo();
		try {
			const summaries = await buildTriggerSummaries({
				projectId,
				triggers: [NIGHTLY],
				repo,
				now: new Date("2026-05-10T12:00:00.000Z"),
			});
			expect(summaries.length).toBe(1);
			const t = summaries[0];
			expect(t?.id).toBe("nightly");
			expect(t?.nextFireAt).toBe("2026-05-11T02:00:00.000Z");
			expect(t?.lastFiredAt).toBeNull();
			expect(t?.lastRunId).toBeNull();
			expect(t?.parseError).toBeNull();
		} finally {
			await close();
		}
	});

	test("joins persisted state from the triggers repo", async () => {
		const { repo, projectId, close } = await makeRepo();
		try {
			await repo.upsert({
				projectId,
				triggerId: "nightly",
				lastFiredAt: "2026-05-09T02:00:00.000Z",
				nextFireAt: "2026-05-10T02:00:00.000Z",
				// lastRunId omitted — FK constraint requires a real run row,
				// which this test doesn't need to assert on.
			});

			const summaries = await buildTriggerSummaries({
				projectId,
				triggers: [NIGHTLY],
				repo,
				now: new Date("2026-05-10T12:00:00.000Z"),
			});
			const t = summaries[0];
			expect(t?.lastFiredAt).toBe("2026-05-09T02:00:00.000Z");
			// Fresh-computed nextFireAt beats the stale persisted value.
			expect(t?.nextFireAt).toBe("2026-05-11T02:00:00.000Z");
		} finally {
			await close();
		}
	});

	test("surfaces croner parse failure as parseError, falls back to persisted nextFireAt", async () => {
		const { repo, projectId, close } = await makeRepo();
		try {
			await repo.upsert({
				projectId,
				triggerId: "bad",
				lastFiredAt: null,
				nextFireAt: "2026-05-10T02:00:00.000Z",
			});

			// Loose-pass cron (5 tokens) that croner rejects: 99 minutes.
			const bad: CronTrigger = {
				id: "bad",
				kind: "cron",
				cron: "99 * * * *",
				seed: "warren-1",
				role: "refactor-bot",
			};
			const summaries = await buildTriggerSummaries({
				projectId,
				triggers: [bad],
				repo,
				now: new Date("2026-05-10T12:00:00.000Z"),
			});
			const t = summaries[0];
			expect(t?.parseError).not.toBeNull();
			// Falls back to the persisted value rather than null.
			expect(t?.nextFireAt).toBe("2026-05-10T02:00:00.000Z");
		} finally {
			await close();
		}
	});
});

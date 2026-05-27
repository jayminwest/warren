import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { recoverActiveRunStreams } from "./recover.ts";
import { makePool } from "./test-helpers.ts";
import type { BridgeRunStreamInput } from "./types.ts";

describe("recoverActiveRunStreams", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		// Seed three runs:
		//   run_a: queued + burrowRunId  → bridge
		//   run_b: running + burrowRunId → bridge
		//   run_c: running, no burrowRunId → skip
		//   run_d: succeeded             → ignore
		await repos.runs.create({
			id: "run_aaaaaaaaaaaa",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_a",
			burrowRunId: "rb_a",
		});
		const b = await repos.runs.create({
			id: "run_bbbbbbbbbbbb",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_b",
			burrowRunId: "rb_b",
		});
		await repos.runs.markRunning(b.id);
		await repos.runs.create({
			id: "run_cccccccccccc",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		await repos.runs.markRunning("run_cccccccccccc");
		const d = await repos.runs.create({
			id: "run_dddddddddddd",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_d",
			burrowRunId: "rb_d",
		});
		await repos.runs.markRunning(d.id);
		await repos.runs.finalize(d.id, "succeeded");
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("starts a bridge for each active run with a burrow_run_id", async () => {
		const calls: { runId: string; burrowRunId: string }[] = [];
		const result = await recoverActiveRunStreams({
			repos,
			broker,
			burrowClientPool: await makePool(repos),
			bridge: async (input: BridgeRunStreamInput) => {
				calls.push({ runId: input.runId, burrowRunId: input.burrowRunId });
				return { written: 0, skipped: 0, errored: false };
			},
		});
		expect(result.bridges).toHaveLength(2);
		expect(result.skipped).toEqual([{ runId: "run_cccccccccccc", reason: "no_burrow_run_id" }]);
		await Promise.all(result.bridges.map((b) => b.done));
		const ids = calls.map((c) => c.runId).sort();
		expect(ids).toEqual(["run_aaaaaaaaaaaa", "run_bbbbbbbbbbbb"]);
	});

	test("returned AbortControllers can stop in-flight bridges", async () => {
		const result = await recoverActiveRunStreams({
			repos,
			broker,
			burrowClientPool: await makePool(repos),
			bridge: async (input: BridgeRunStreamInput) => {
				await new Promise<void>((resolve) => {
					if (input.signal === undefined) {
						resolve();
						return;
					}
					if (input.signal.aborted) {
						resolve();
						return;
					}
					input.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { written: 0, skipped: 0, errored: false };
			},
		});
		for (const b of result.bridges) b.abort.abort();
		await Promise.all(result.bridges.map((b) => b.done));
		expect(result.bridges).toHaveLength(2);
	});
});

/**
 * Crash-recovery lifetime exemption for `conversation` runs (warren-c770).
 *
 * `bootBridges` pre-probes every active run's burrow run and, on a 404,
 * finalizes the warren row to `failed`/`burrow_run_lost`. A `conversation`
 * run legitimately loses its burrow run across a host
 * restart — the pi-chat session lived in burrow's in-memory store — so it
 * must be skipped without tombstoning. Re-wake (warren-6ccf) spawns a fresh
 * session that replays the persisted transcript.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { makePool, stub } from "./bridges.test-helpers.ts";
import { bootBridges } from "./bridges.ts";

describe("bootBridges — conversation crash-recovery", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: { name: "refactor-bot" } });
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	test("warren-c770: pre-probe 404 on a conversation run skips bridge without finalizing", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const r = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
			mode: "conversation",
		});
		await repos.runs.attachBurrow(r.id, {
			burrowId: "bur_convlostlost",
			burrowRunId: "rb_convghost01",
		});
		await repos.burrows.create({ id: "bur_convlostlost", workerId: "local" });
		await repos.runs.markRunning(r.id);

		const ghostClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "not_found", message: "run not found: rb_convghost01" },
						}),
						{ status: 404, headers: { "content-type": "application/json" } },
					),
			),
		});
		const pool = await makePool(repos, ghostClient);

		const calls: string[] = [];
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: pool,
			bridge: async (input) => {
				calls.push(input.runId);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		expect(calls).toEqual([]);
		expect(result.resumed).toEqual([]);
		expect(result.skipped).toEqual([{ runId: r.id, reason: "conversation_burrow_lost" }]);
		// The conversation row stays non-terminal — re-wake (warren-6ccf) owns it.
		const run = await repos.runs.require(r.id);
		expect(run.state).toBe("running");
		expect(run.failureReason).toBeNull();
		expect((await repos.events.listByRun(r.id)).length).toBe(0);
		await result.registry.stopAll();
	});
});

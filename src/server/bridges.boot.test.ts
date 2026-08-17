import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { makeProvider } from "./bridges.test-helpers.ts";
import { bootBridges, createBridgeRegistry } from "./bridges.ts";

describe("bootBridges", () => {
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

	test("resumes runs with a sandbox_run_id; skips ones without", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const r1 = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r1.id, {
			sandboxId: "bur_xxxxxxxxxxxx",
			sandboxRunId: "run_zzzzzzzzzzzz",
		});

		const r2 = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		// r2 has no sandbox_run_id — partial spawn

		const calls: string[] = [];
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: makeProvider().provider,
			bridge: async (input) => {
				calls.push(input.runId);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		expect(result.resumed.map((r) => r.runId)).toEqual([r1.id]);
		expect(result.skipped.map((s) => s.runId)).toEqual([r2.id]);
		expect(calls).toEqual([r1.id]);
		await result.registry.stopAll();
	});

	test("warren-3743: resumes every run with burrow ids (no placement-row gate)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		// The `burrows` placement table was dropped in warren-3743, so the old
		// "pre-pl-9ba1 orphan" skip (reason: no_placement) no longer applies —
		// any active run carrying a sandbox_id + sandbox_run_id resumes.
		const r1 = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r1.id, {
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "rb_aaaaaaaaaa",
		});

		const r2 = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r2.id, {
			sandboxId: "bur_secondsecond",
			sandboxRunId: "rb_second_aaaa",
		});

		const calls: string[] = [];
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: makeProvider().provider,
			bridge: async (input) => {
				calls.push(input.runId);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		expect(result.resumed.map((r) => r.runId).sort()).toEqual([r1.id, r2.id].sort());
		expect(result.skipped).toEqual([]);
		expect(calls.sort()).toEqual([r1.id, r2.id].sort());
		await result.registry.stopAll();
	});

	test("warren-b1a9: pre-probe 404 reconciles run to failed/sandbox_run_lost without starting bridge", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const r = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r.id, {
			sandboxId: "bur_lostlostlost",
			sandboxRunId: "rb_ghostghost1",
		});
		await repos.runs.markRunning(r.id);

		// Ghost run: `status().exists === false` (a GC'd pod / burrow 404). The
		// teardown terminate also fails (the sandbox is already gone), preserving the
		// warren-4f01 `reap.workspace_destroy_failed` audit expectation below.
		const { provider } = makeProvider({
			exists: false,
			throwOnTerminate: new Error("run not found: rb_ghostghost1"),
		});

		const calls: string[] = [];
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
			bridge: async (input) => {
				calls.push(input.runId);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		expect(calls).toEqual([]);
		expect(result.resumed).toEqual([]);
		expect(result.skipped).toEqual([{ runId: r.id, reason: "sandbox_run_lost" }]);
		const run = await repos.runs.require(r.id);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("sandbox_run_lost");
		const events = await repos.events.listByRun(r.id);
		expect(events[0]?.kind).toBe("bridge_lost");
		expect((events[0]?.payloadJson as { reason: string }).reason).toBe("sandbox_run_lost");
		expect(events.map((e) => e.kind)).toContain("reap.workspace_destroy_failed"); // warren-4f01
		await result.registry.stopAll();
	});

	test("warren-b1a9: bridge sandboxRunMissing reconciles + stops reconnect loop", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const r = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r.id, {
			sandboxId: "bur_a",
			sandboxRunId: "rb_a",
		});
		await repos.runs.markRunning(r.id);

		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: makeProvider().provider,
			bridge: async () => {
				calls += 1;
				return { written: 0, skipped: 0, errored: false, sandboxRunMissing: true as const };
			},
			reconnectBackoffMs: [0],
		});

		registry.start(r.id, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((res) => setTimeout(res, 0));
		expect(calls).toBe(1); // No reconnect after sandboxRunMissing.
		const run = await repos.runs.require(r.id);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("sandbox_run_lost");
		const events = await repos.events.listByRun(r.id);
		expect(events.some((e) => e.kind === "bridge_lost")).toBe(true);
	});

	test("returns an empty registry when no active runs", async () => {
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: makeProvider().provider,
		});
		expect(result.resumed.length).toBe(0);
		expect(result.skipped.length).toBe(0);
		expect(result.registry.size()).toBe(0);
		await result.registry.stopAll();
	});
});

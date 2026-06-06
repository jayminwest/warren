import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { DEFAULT_DISPATCHER_HANDLE, spawnRun } from "./index.ts";
import {
	makeAgentJson,
	makeAppender,
	makeBurrowClient,
	makePool,
	setupRepos,
} from "./test-helpers.ts";
import type { AppendPlotRunDispatchedInput } from "./types.ts";

describe("spawnRun: plotId gating + PLOT env injection (warren-a8c3 / warren-e26f)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("rejects plotId when project.hasPlot is false (warren-a8c3)", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
				plotId: "plot-2047abc1",
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("persists plotId on the runs row when project.hasPlot is true (warren-a8c3)", async () => {
		// No public mutator on ProjectsRepo for has_plot yet — refreshProjectClone
		// is the production write path (warren-4e20). Flip the column directly so
		// the test isolates the spawn-side surface; the integration end-to-end
		// is covered by warren-4e06's acceptance scenario.
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");

		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
		});
		expect(result.run.plotId).toBe("plot-2047abc1");
		const reread = await repos.runs.require(result.run.id);
		expect(reread.plotId).toBe("plot-2047abc1");
	});

	test("injects PLOT_ID + PLOT_ACTOR onto the burrow up call when plotId is set (warren-e26f)", async () => {
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");

		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
		});

		const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
		expect(up).toBeDefined();
		const env = (up?.body as { env?: Record<string, string> }).env;
		// BUN_INSTALL_CACHE_DIR is always injected (warren-b893); check the
		// Plot-specific vars are also present.
		expect(env).toMatchObject({
			PLOT_ID: "plot-2047abc1",
			PLOT_ACTOR: `agent:refactor-bot:${result.run.id}`,
			BUN_INSTALL_CACHE_DIR: "/tmp/bun-install-cache",
		});
	});

	test("omits env from the burrow up call when no plotId is set (warren-e26f)", async () => {
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
		});

		const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
		expect(up).toBeDefined();
		// env is always set (at minimum BUN_INSTALL_CACHE_DIR — warren-b893).
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env).toEqual({ BUN_INSTALL_CACHE_DIR: "/tmp/bun-install-cache" });
	});
});

describe("spawnRun: run_dispatched Plot append (warren-e848)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");
	});
	afterEach(async () => {
		await db.close();
	});

	test("appends run_dispatched to the originating Plot after spawn", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({ frontmatter: { model: "claude-opus-4-7" } }),
		});
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			dispatcherHandle: "alice",
			plotAppender: makeAppender({ calls: appendCalls }),
		});

		expect(appendCalls).toHaveLength(1);
		const call = appendCalls[0];
		if (!call) throw new Error("appender not called");
		expect(call.plotDir).toBe("/data/projects/x/y/.plot");
		expect(call.plotId).toBe("plot-2047abc1");
		expect(call.handle).toBe("alice");
		expect(call.runId).toBe(result.run.id);
		expect(call.agentName).toBe("refactor-bot");
		expect(call.model).toBe("claude-opus-4-7");
		expect(call.projectId).toBe("prj_xxxxxxxxxxxx");
		expect(await repos.events.maxSeqForRun(result.run.id)).toBeNull();
	});

	test("skips run_dispatched append when no plotId is set", async () => {
		// reset has_plot for this test (no plotId in dispatch)
		db.raw.exec("UPDATE projects SET has_plot = 0 WHERE id = 'prj_xxxxxxxxxxxx'");
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotAppender: makeAppender({ calls: appendCalls }),
		});
		expect(appendCalls).toHaveLength(0);
	});

	test("falls back to DEFAULT_DISPATCHER_HANDLE when handle is malformed", async () => {
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			dispatcherHandle: "@bad/handle",
			plotAppender: makeAppender({ calls: appendCalls }),
		});
		expect(appendCalls[0]?.handle).toBe(DEFAULT_DISPATCHER_HANDLE);
	});

	test("uses DEFAULT_DISPATCHER_HANDLE when dispatcherHandle is omitted", async () => {
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			plotAppender: makeAppender({ calls: appendCalls }),
		});
		expect(appendCalls[0]?.handle).toBe(DEFAULT_DISPATCHER_HANDLE);
	});

	test("records plot_run_dispatched_failed and does NOT roll back when the appender throws", async () => {
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			plotAppender: makeAppender({ throws: new Error("rebuild failed too") }),
		});
		// Spawn returned a non-cancelled run row, proving the failure didn't
		// roll the dispatch back.
		expect(result.run.state === "queued" || result.run.state === "running").toBe(true);
		const events = await repos.events.listByRun(result.run.id);
		const failure = events.find((e) => e.kind === "plot_run_dispatched_failed");
		expect(failure).toBeDefined();
		expect(failure?.stream).toBe("system");
		const payload = failure?.payloadJson as { plotId?: string; reason?: string };
		expect(payload?.plotId).toBe("plot-2047abc1");
		expect(payload?.reason).toContain("rebuild failed too");
	});

	test("passes model=null when the agent has no frontmatter.model", async () => {
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			plotAppender: makeAppender({ calls: appendCalls }),
		});
		expect(appendCalls[0]?.model).toBeNull();
	});
});

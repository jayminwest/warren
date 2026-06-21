import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { SpawnFn as ProjectSpawnFn, SpawnResult } from "../../projects/clone.ts";
import { spawnRun } from "./index.ts";
import { makeBurrowClient, makePool, setupRepos } from "./test-helpers.ts";

describe("spawnRun: post-dispatch seed extension write (pl-bb70)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("stamps {role,trigger,lastRunId,lastRunAt} on the seed when seedId + seedsCli are wired", async () => {
		const { client } = makeBurrowClient();
		const sdCalls: { cmd: readonly string[]; cwd: string }[] = [];
		const seedsSpawn: ProjectSpawnFn = async (cmd, opts) => {
			sdCalls.push({ cmd, cwd: opts.cwd });
			return { stdout: "{}", stderr: "", exitCode: 0 } satisfies SpawnResult;
		};
		const fixedNow = new Date("2026-05-15T17:00:00.000Z");
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
			seedsCli: { sdBinary: "/opt/sd", spawn: seedsSpawn },
			now: () => fixedNow,
		});

		expect(sdCalls).toHaveLength(1);
		const call = sdCalls[0];
		if (call === undefined) throw new Error("expected one sd call");
		expect(call.cwd).toBe("/data/projects/x/y");
		expect(call.cmd[0]).toBe("/opt/sd");
		expect(call.cmd[1]).toBe("update");
		expect(call.cmd[2]).toBe("warren-abc");
		expect(call.cmd[3]).toBe("--extensions");
		expect(JSON.parse(call.cmd[4] ?? "{}")).toEqual({
			role: "refactor-bot",
			trigger: "manual",
			lastRunId: result.run.id,
			lastRunAt: fixedNow.toISOString(),
		});

		// No system event — the write succeeded
		expect(await repos.events.countByRun(result.run.id)).toBe(0);
	});

	test("routes the sd update to seedProjectId while the workspace clones projectId (warren-c1a4)", async () => {
		// Register a second, coordination project distinct from the execution
		// project the workspace clones.
		await repos.projects.create({
			id: "prj_meta00000000",
			gitUrl: "https://github.com/x/meta.git",
			localPath: "/data/projects/x/meta",
			defaultBranch: "main",
		});
		const { client, calls } = makeBurrowClient();
		const sdCalls: { cmd: readonly string[]; cwd: string }[] = [];
		const seedsSpawn: ProjectSpawnFn = async (cmd, opts) => {
			sdCalls.push({ cmd, cwd: opts.cwd });
			return { stdout: "{}", stderr: "", exitCode: 0 } satisfies SpawnResult;
		};
		const fixedNow = new Date("2026-05-15T17:00:00.000Z");
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			seedProjectId: "prj_meta00000000",
			prompt: "fix it",
			seedId: "warren-abc",
			seedsCli: { sdBinary: "/opt/sd", spawn: seedsSpawn },
			now: () => fixedNow,
		});

		// The seed stamp ran against the COORDINATION project clone.
		expect(sdCalls).toHaveLength(1);
		const call = sdCalls[0];
		if (call === undefined) throw new Error("expected one sd call");
		expect(call.cwd).toBe("/data/projects/x/meta");
		expect(call.cmd[2]).toBe("warren-abc");
		expect(JSON.parse(call.cmd[4] ?? "{}")).toEqual({
			role: "refactor-bot",
			trigger: "manual",
			lastRunId: result.run.id,
			lastRunAt: fixedNow.toISOString(),
		});

		// The burrow workspace still cloned the EXECUTION project, and the run
		// row records the execution project id.
		expect(result.run.projectId).toBe("prj_xxxxxxxxxxxx");
		const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
		expect((up?.body as { projectRoot?: string })?.projectRoot).toBe("/data/projects/x/y");
	});

	test("seedId without seedsCli is a no-op extension write (legacy callers, CLI)", async () => {
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
		});
		expect(result.run.seedId).toBe("warren-abc");
		expect(await repos.events.countByRun(result.run.id)).toBe(0);
	});

	test("seedsCli without seedId never shells out", async () => {
		const { client } = makeBurrowClient();
		let sdCalled = false;
		const seedsSpawn: ProjectSpawnFn = async () => {
			sdCalled = true;
			return { stdout: "{}", stderr: "", exitCode: 0 };
		};
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
		});
		expect(sdCalled).toBe(false);
	});

	test("emits seeds_extension_write_failed on a failing sd update without rolling back the run (acceptance #5)", async () => {
		const { client } = makeBurrowClient();
		const seedsSpawn: ProjectSpawnFn = async () => ({
			stdout: "",
			stderr: "seeds: no such issue warren-abc",
			exitCode: 1,
		});
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
		});

		// Run survived the extension-write failure — burrow row is attached,
		// state stayed queued.
		const reread = await repos.runs.require(result.run.id);
		expect(reread.state).toBe("queued");
		expect(reread.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(reread.burrowRunId).toBe("run_zzzzzzzzzzzz");

		// A single system event surfaces the lingering extension to the
		// operator without forcing them to tail logs.
		const events = await repos.events.listByRun(result.run.id);
		expect(events).toHaveLength(1);
		const evt = events[0];
		if (evt === undefined) throw new Error("expected one event");
		expect(evt.kind).toBe("seeds_extension_write_failed");
		expect(evt.stream).toBe("system");
		expect(evt.burrowEventSeq).toBe(1);
		const payload = evt.payloadJson as { seedId: string; reason: string };
		expect(payload.seedId).toBe("warren-abc");
		expect(payload.reason).toContain("sd update");
	});

	test("drops an unrecognized trigger string but still writes role/lastRunId/lastRunAt (src/server/handlers/projects.ts 'manual-trigger')", async () => {
		const { client } = makeBurrowClient();
		const sdCalls: { cmd: readonly string[] }[] = [];
		const seedsSpawn: ProjectSpawnFn = async (cmd) => {
			sdCalls.push({ cmd });
			return { stdout: "{}", stderr: "", exitCode: 0 };
		};
		const fixedNow = new Date("2026-05-15T17:00:00.000Z");
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
			trigger: "manual-trigger",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
			now: () => fixedNow,
		});

		expect(sdCalls).toHaveLength(1);
		expect(JSON.parse(sdCalls[0]?.cmd[4] ?? "{}")).toEqual({
			role: "refactor-bot",
			lastRunId: result.run.id,
			lastRunAt: fixedNow.toISOString(),
		});
		expect(await repos.events.countByRun(result.run.id)).toBe(0);
	});
});

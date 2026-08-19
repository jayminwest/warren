import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { SpawnFn as ProjectSpawnFn, SpawnResult } from "../../projects/clone.ts";
import type { IssueTracker, MetadataCapableTracker } from "../../tracker/contract.ts";
import { spawnRun } from "./index.ts";
import { UNKNOWN_TRIGGER_EVENT, writeSeedExtensions } from "./seed-extensions.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";
import type { SpawnLogger } from "./types.ts";

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
		const { client } = makeSandboxClient();
		const sdCalls: { cmd: readonly string[]; cwd: string }[] = [];
		const seedsSpawn: ProjectSpawnFn = async (cmd, opts) => {
			sdCalls.push({ cmd, cwd: opts.cwd });
			return { stdout: "{}", stderr: "", exitCode: 0 } satisfies SpawnResult;
		};
		const fixedNow = new Date("2026-05-15T17:00:00.000Z");
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
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

	test("seedId without seedsCli is a no-op extension write (legacy callers, CLI)", async () => {
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
		});
		expect(result.run.seedId).toBe("warren-abc");
		expect(await repos.events.countByRun(result.run.id)).toBe(0);
	});

	test("seedsCli without seedId never shells out", async () => {
		const { client } = makeSandboxClient();
		let sdCalled = false;
		const seedsSpawn: ProjectSpawnFn = async () => {
			sdCalled = true;
			return { stdout: "{}", stderr: "", exitCode: 0 };
		};
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
		});
		expect(sdCalled).toBe(false);
	});

	test("emits seeds_extension_write_failed on a failing sd update without rolling back the run (acceptance #5)", async () => {
		const { client } = makeSandboxClient();
		const seedsSpawn: ProjectSpawnFn = async () => ({
			stdout: "",
			stderr: "seeds: no such issue warren-abc",
			exitCode: 1,
		});
		const fixedNow = new Date("2026-05-15T17:00:00.000Z");
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
			now: () => fixedNow,
		});

		// Run survived the extension-write failure — burrow row is attached,
		// state stayed queued.
		const reread = await repos.runs.require(result.run.id);
		expect(reread.state).toBe("queued");
		expect(reread.sandboxId).toBe("bur_aaaaaaaaaaaa");
		expect(reread.sandboxRunId).toBe("run_zzzzzzzzzzzz");

		// A single system event surfaces the lingering extension to the
		// operator without forcing them to tail logs.
		const events = await repos.events.listByRun(result.run.id);
		expect(events).toHaveLength(1);
		const evt = events[0];
		if (evt === undefined) throw new Error("expected one event");
		expect(evt.kind).toBe("seeds_extension_write_failed");
		expect(evt.stream).toBe("system");
		expect(evt.sandboxEventSeq).toBe(1);
		const payload = evt.payloadJson as { seedId: string; reason: string };
		expect(payload.seedId).toBe("warren-abc");
		expect(payload.reason).toContain("sd update");
		// The envelope `ts` is stamped from the injected `now` clock (warren-96fd) —
		// the same clock that seeds the success-path `lastRunAt` extension write.
		expect(evt.ts).toBe(fixedNow.toISOString());
	});

	// warren-c486: every kind a live dispatcher passes must round-trip into the
	// seed's `trigger` extension. The old hand-copied enum covered six of ten,
	// so these four silently lost provenance.
	for (const [trigger, expected] of [
		["manual", "manual"],
		["cron", "cron"],
		["scheduled", "scheduled"],
		["cli", "cli"],
		["plan-run", "plan-run"],
		["auto_plan_run", "auto_plan_run"],
		["ci-fixer", "ci-fixer"],
		["healer", "healer"],
		// Legacy alias from POST /projects/:id/triggers/:triggerId/run.
		["manual-trigger", "manual"],
	] as const) {
		test(`round-trips trigger '${trigger}' into the seed extensions`, async () => {
			const { client } = makeSandboxClient();
			const sdCalls: { cmd: readonly string[] }[] = [];
			const seedsSpawn: ProjectSpawnFn = async (cmd) => {
				sdCalls.push({ cmd });
				return { stdout: "{}", stderr: "", exitCode: 0 };
			};
			const fixedNow = new Date("2026-05-15T17:00:00.000Z");
			const result = await spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
				seedId: "warren-abc",
				trigger,
				seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
				now: () => fixedNow,
			});

			expect(JSON.parse(sdCalls[0]?.cmd[4] ?? "{}")).toEqual({
				role: "refactor-bot",
				trigger: expected,
				lastRunId: result.run.id,
				lastRunAt: fixedNow.toISOString(),
			});
			// No system event — nothing was dropped.
			expect(await repos.events.countByRun(result.run.id)).toBe(0);
		});
	}

	test("drops an unknown trigger string LOUDLY: warns + emits seeds_trigger_kind_unknown", async () => {
		const { client } = makeSandboxClient();
		const warnings: { trigger: string }[] = [];
		const logger: SpawnLogger = {
			info: () => {},
			warn: (fields: object) => {
				warnings.push(fields as { trigger: string });
			},
			error: () => {},
			child() {
				return logger;
			},
		};
		const sdCalls: { cmd: readonly string[] }[] = [];
		const seedsSpawn: ProjectSpawnFn = async (cmd) => {
			sdCalls.push({ cmd });
			return { stdout: "{}", stderr: "", exitCode: 0 };
		};
		const fixedNow = new Date("2026-05-15T17:00:00.000Z");
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
			trigger: "totally-made-up",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
			now: () => fixedNow,
			logger,
		});

		expect(sdCalls).toHaveLength(1);
		// The rest of the payload still lands — a strict-schema rejection would
		// have lost role / lastRunId / lastRunAt too.
		expect(JSON.parse(sdCalls[0]?.cmd[4] ?? "{}")).toEqual({
			role: "refactor-bot",
			lastRunId: result.run.id,
			lastRunAt: fixedNow.toISOString(),
		});

		// …but the drop is visible: one warning and one system event.
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.trigger).toBe("totally-made-up");
		const events = await repos.events.listByRun(result.run.id);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe(UNKNOWN_TRIGGER_EVENT);
		expect(events[0]?.stream).toBe("system");
		expect((events[0]?.payloadJson as { trigger: string }).trigger).toBe("totally-made-up");
	});
});

describe("writeSeedExtensions: capability gating (warren-6234)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("skips the write with a debug log when the tracker lacks supportsMetadata", async () => {
		let mergeCalls = 0;
		const debugs: string[] = [];
		const tracker: IssueTracker & Partial<MetadataCapableTracker> = {
			capabilities: {
				supportsPlans: false,
				supportsMetadata: false,
				supportsScheduledIssues: false,
				isGitNative: false,
			},
			getIssue: async () => {
				throw new Error("unused");
			},
			listIssueStatuses: async () => new Map(),
			closeIssue: async () => {},
			mergeIssueMetadata: async () => {
				mergeCalls += 1;
			},
		};
		const logger: SpawnLogger = {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: (_fields, msg) => void debugs.push(msg ?? ""),
			child() {
				return logger;
			},
		};
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
		});

		await writeSeedExtensions({
			repos,
			issueTracker: tracker,
			projectId: "prj_xxxxxxxxxxxx",
			projectPath: "/data/projects/x/y",
			seedId: "warren-abc",
			runId: run.id,
			agentName: "refactor-bot",
			trigger: "manual",
			now: new Date("2026-05-15T17:00:00.000Z"),
			logger,
		});

		expect(mergeCalls).toBe(0);
		expect(debugs.some((m) => m.includes("metadata"))).toBe(true);
		expect(await repos.events.countByRun(run.id)).toBe(0);
	});

	test("routes the merge through tracker.mergeIssueMetadata with the tracker context", async () => {
		const merges: Array<{ projectId: string; localPath?: string; seedId: string }> = [];
		const tracker: IssueTracker & Partial<MetadataCapableTracker> = {
			capabilities: {
				supportsPlans: true,
				supportsMetadata: true,
				supportsScheduledIssues: true,
				isGitNative: true,
			},
			getIssue: async () => {
				throw new Error("unused");
			},
			listIssueStatuses: async () => new Map(),
			closeIssue: async () => {},
			mergeIssueMetadata: async (ctx, seedId) => {
				merges.push({ projectId: ctx.projectId, localPath: ctx.localPath, seedId });
			},
		};

		await writeSeedExtensions({
			repos,
			issueTracker: tracker,
			projectId: "prj_xxxxxxxxxxxx",
			projectPath: "/data/projects/x/y",
			seedId: "warren-abc",
			runId: "run_x",
			agentName: "refactor-bot",
			now: new Date("2026-05-15T17:00:00.000Z"),
		});

		expect(merges).toEqual([
			{ projectId: "prj_xxxxxxxxxxxx", localPath: "/data/projects/x/y", seedId: "warren-abc" },
		]);
	});
});

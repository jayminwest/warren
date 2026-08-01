import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { RunRow, RunTerminalState } from "../../db/schema.ts";
import {
	type BridgeRunStreamResult,
	RunEventBroker,
	type SpawnRunResult,
} from "../../runs/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { CliContext } from "../output.ts";
import { runRun } from "./run.ts";

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: {},
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		now: () => new Date("2026-05-08T12:00:00.000Z"),
	};
	return { context, out, err };
}

/**
 * Minimal RuntimeProvider stub (warren-11cc). The run-command tests stub
 * spawn/bridge/reap/fetchBurrowRunState, so the provider's methods are never
 * actually driven here — it exists to satisfy the required `runtimeProvider`
 * dep. `capabilities.previewPorts` is `false` so the preview sub-step stays
 * dark (tests wire `previewSidecars` explicitly if they need it).
 */
function fakeProvider(): RuntimeProvider {
	const notWired = () => {
		throw new Error("fakeProvider: method not wired for this test");
	};
	return {
		capabilities: {
			previewPorts: false,
			networkPolicy: "domain-allowlist",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: true,
			workspaceGc: true,
		},
		create: notWired as never,
		streamEvents: notWired as never,
		status: notWired as never,
		sendMessage: notWired as never,
		cancel: notWired as never,
		workspaceInfo: notWired as never,
		finalize: notWired as never,
		terminate: notWired as never,
	};
}

function fakeRunDeps(_repos: Repos): { runtimeProvider: RuntimeProvider } {
	return { runtimeProvider: fakeProvider() };
}

function buildSpawnStub(repos: Repos, agentName: string, projectId: string) {
	return async (): Promise<SpawnRunResult> => {
		const run: RunRow = await repos.runs.create({
			agentName,
			projectId,
			prompt: "fix the bug",
			renderedAgentJson: { name: agentName, version: 1, sections: { system: "x" } },
			trigger: "cli",
			now: new Date("2026-05-08T12:00:00.000Z"),
		});
		const burrow: Burrow = {
			id: "bur_aaaaaaaaaaaa",
			parentId: null,
			kind: "task",
			name: null,
			projectRoot: "/tmp/p",
			workspacePath: "/tmp/p/ws",
			branch: "warren/run/x",
			provider: "local",
			providerStateJson: null,
			profileJson: {},
			state: "active",
			createdAt: new Date(),
			updatedAt: new Date(),
			destroyedAt: null,
		};
		const burrowRun: BurrowRun = {
			id: "run_zzzzzzzzzzzz",
			burrowId: burrow.id,
			agentId: agentName,
			prompt: "fix the bug",
			resumeOfRunId: null,
			state: "queued",
			exitCode: null,
			errorMessage: null,
			metadataJson: null,
			queuedAt: new Date(),
			startedAt: null,
			completedAt: null,
		};
		await repos.runs.attachBurrow(run.id, { burrowId: burrow.id, burrowRunId: burrowRun.id });
		return {
			run,
			burrow,
			burrowRun,
			agent: {
				name: agentName,
				version: 1,
				sections: { system: "x" },
				resolvedFrom: [],
				frontmatter: {},
			},
		};
	};
}

describe("runRun", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		// Seed an agent + project so referential checks would pass for spawnRun
		// callers; the stubbed spawn we install below does not actually consult
		// these, but inserting them documents the contract.
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { name: "refactor-bot", version: 1, sections: { system: "x" } },
			now: new Date("2026-05-08T12:00:00.000Z"),
		});
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/tmp/p",
			defaultBranch: "main",
			now: new Date("2026-05-08T12:00:00.000Z"),
		});
	});

	afterEach(async () => {
		await db.close();
	});

	test("rejects missing args with exit 2", async () => {
		const { context } = captureContext();
		const result = await runRun(
			context,
			{ repos, ...fakeRunDeps(repos) },
			{ agent: "", project: "", prompt: "" },
		);
		expect(result.exitCode).toBe(2);
	});

	test("orchestrates spawn → tail → reap and exits 0 on succeeded", async () => {
		const projectId = (await repos.projects.listAll())[0]?.id as string;
		const broker = new RunEventBroker();
		const { context, out, err } = captureContext();

		// Bridge resolves immediately; the runner closes the broker in `finally`,
		// so the tail iterator returns empty.
		const bridgeStub = (async (): Promise<BridgeRunStreamResult> => ({
			written: 0,
			skipped: 0,
			errored: false,
		})) as never;

		const reapStub = (async (input: { runId: string; outcome: RunTerminalState }) => {
			await repos.runs.markRunning(input.runId, new Date("2026-05-08T12:00:01.000Z"));
			await repos.runs.finalize(input.runId, input.outcome, new Date("2026-05-08T12:00:02.000Z"));
			return {
				state: input.outcome,
				mulchUpdated: 0,
				mulchSkipped: 0,
				mulchAppended: 0,
				seedsClosed: 0,
				seedsCreated: 0,
				branchPushed: false,
				errors: [],
				alreadyTerminal: false,
			};
		}) as never;

		const result = await runRun(
			context,
			{
				repos,
				...fakeRunDeps(repos),
				broker,
				spawn: buildSpawnStub(repos, "refactor-bot", projectId) as never,
				bridge: bridgeStub,
				reap: reapStub,
				fetchBurrowRunState: async () => "succeeded",
			},
			{ agent: "refactor-bot", project: projectId, prompt: "fix the bug" },
		);

		expect(err).toEqual([]);
		expect(result.exitCode).toBe(0);
		expect(result.state).toBe("succeeded");
		const events = out.map((l) => JSON.parse(l) as { event: string });
		const kinds = events.map((e) => e.event);
		expect(kinds).toContain("run.spawned");
		expect(kinds).toContain("run.reaped");
	});

	test("exits 1 when reap reports a non-success terminal state", async () => {
		const projectId = (await repos.projects.listAll())[0]?.id as string;
		const broker = new RunEventBroker();
		const { context } = captureContext();

		const bridgeStub = (async (): Promise<BridgeRunStreamResult> => ({
			written: 0,
			skipped: 0,
			errored: false,
		})) as never;
		const reapStub = (async (input: { runId: string; outcome: RunTerminalState }) => {
			await repos.runs.markRunning(input.runId, new Date("2026-05-08T12:00:01.000Z"));
			await repos.runs.finalize(input.runId, input.outcome, new Date("2026-05-08T12:00:02.000Z"));
			return {
				state: input.outcome,
				mulchUpdated: 0,
				mulchSkipped: 0,
				mulchAppended: 0,
				seedsClosed: 0,
				seedsCreated: 0,
				branchPushed: false,
				errors: [],
				alreadyTerminal: false,
			};
		}) as never;

		const result = await runRun(
			context,
			{
				repos,
				...fakeRunDeps(repos),
				broker,
				spawn: buildSpawnStub(repos, "refactor-bot", projectId) as never,
				bridge: bridgeStub,
				reap: reapStub,
				fetchBurrowRunState: async () => "failed",
			},
			{ agent: "refactor-bot", project: projectId, prompt: "fix the bug" },
		);

		expect(result.exitCode).toBe(1);
		expect(result.state).toBe("failed");
	});

	test("prefers the bridge's in-stream terminal outcome over the status probe", async () => {
		// warren-2909 / GH #663: the terminal result envelope lands before burrow
		// finalizes the run row, so a one-shot status() probe still reads
		// `running`. The bridge's terminalDetected (in-stream detection) must win
		// and the probe must not fire at all.
		const projectId = (await repos.projects.listAll())[0]?.id as string;
		const broker = new RunEventBroker();
		const { context } = captureContext();

		const bridgeStub = (async (): Promise<BridgeRunStreamResult> => ({
			written: 0,
			skipped: 0,
			errored: false,
			terminalDetected: { outcome: "succeeded" },
		})) as never;
		const reapStub = (async (input: { runId: string; outcome: RunTerminalState }) => {
			await repos.runs.markRunning(input.runId, new Date("2026-05-08T12:00:01.000Z"));
			await repos.runs.finalize(input.runId, input.outcome, new Date("2026-05-08T12:00:02.000Z"));
			return {
				state: input.outcome,
				mulchUpdated: 0,
				mulchSkipped: 0,
				mulchAppended: 0,
				seedsClosed: 0,
				seedsCreated: 0,
				branchPushed: false,
				errors: [],
				alreadyTerminal: false,
			};
		}) as never;

		let probeCalls = 0;
		const result = await runRun(
			context,
			{
				repos,
				...fakeRunDeps(repos),
				broker,
				spawn: buildSpawnStub(repos, "refactor-bot", projectId) as never,
				bridge: bridgeStub,
				reap: reapStub,
				fetchBurrowRunState: async () => {
					probeCalls++;
					return "failed";
				},
			},
			{ agent: "refactor-bot", project: projectId, prompt: "fix the bug" },
		);

		expect(result.exitCode).toBe(0);
		expect(result.state).toBe("succeeded");
		expect(probeCalls).toBe(0);
	});

	test("threads the bridge's terminal failureReason into reap", async () => {
		// warren-2909: an in-stream failure reason (e.g. oom_killed) must reach
		// reap instead of being re-inferred as `crashed`.
		const projectId = (await repos.projects.listAll())[0]?.id as string;
		const broker = new RunEventBroker();
		const { context } = captureContext();

		const bridgeStub = (async (): Promise<BridgeRunStreamResult> => ({
			written: 0,
			skipped: 0,
			errored: false,
			terminalDetected: { outcome: "failed", failureReason: "oom_killed" },
		})) as never;

		let reapedFailureReason: unknown;
		const reapStub = (async (input: {
			runId: string;
			outcome: RunTerminalState;
			failureReason?: unknown;
		}) => {
			reapedFailureReason = input.failureReason;
			await repos.runs.markRunning(input.runId, new Date("2026-05-08T12:00:01.000Z"));
			await repos.runs.finalize(input.runId, input.outcome, new Date("2026-05-08T12:00:02.000Z"));
			return {
				state: input.outcome,
				mulchUpdated: 0,
				mulchSkipped: 0,
				mulchAppended: 0,
				seedsClosed: 0,
				seedsCreated: 0,
				branchPushed: false,
				errors: [],
				alreadyTerminal: false,
			};
		}) as never;

		const result = await runRun(
			context,
			{
				repos,
				...fakeRunDeps(repos),
				broker,
				spawn: buildSpawnStub(repos, "refactor-bot", projectId) as never,
				bridge: bridgeStub,
				reap: reapStub,
				fetchBurrowRunState: async () => "succeeded",
			},
			{ agent: "refactor-bot", project: projectId, prompt: "fix the bug" },
		);

		expect(result.exitCode).toBe(1);
		expect(result.state).toBe("failed");
		expect(reapedFailureReason).toBe("oom_killed");
	});

	test("falls back to the status probe when the bridge detects no terminal envelope", async () => {
		const projectId = (await repos.projects.listAll())[0]?.id as string;
		const broker = new RunEventBroker();
		const { context } = captureContext();

		const bridgeStub = (async (): Promise<BridgeRunStreamResult> => ({
			written: 0,
			skipped: 0,
			errored: false,
		})) as never;
		const reapStub = (async (input: { runId: string; outcome: RunTerminalState }) => {
			await repos.runs.markRunning(input.runId, new Date("2026-05-08T12:00:01.000Z"));
			await repos.runs.finalize(input.runId, input.outcome, new Date("2026-05-08T12:00:02.000Z"));
			return {
				state: input.outcome,
				mulchUpdated: 0,
				mulchSkipped: 0,
				mulchAppended: 0,
				seedsClosed: 0,
				seedsCreated: 0,
				branchPushed: false,
				errors: [],
				alreadyTerminal: false,
			};
		}) as never;

		let probeCalls = 0;
		const result = await runRun(
			context,
			{
				repos,
				...fakeRunDeps(repos),
				broker,
				spawn: buildSpawnStub(repos, "refactor-bot", projectId) as never,
				bridge: bridgeStub,
				reap: reapStub,
				fetchBurrowRunState: async () => {
					probeCalls++;
					return "succeeded";
				},
			},
			{ agent: "refactor-bot", project: projectId, prompt: "fix the bug" },
		);

		expect(result.exitCode).toBe(0);
		expect(result.state).toBe("succeeded");
		expect(probeCalls).toBe(1);
	});

	test("reads the terminal state through provider.status when no override is wired", async () => {
		const projectId = (await repos.projects.listAll())[0]?.id as string;
		const broker = new RunEventBroker();
		const { context } = captureContext();

		const bridgeStub = (async (): Promise<BridgeRunStreamResult> => ({
			written: 0,
			skipped: 0,
			errored: false,
		})) as never;
		const reapStub = (async (input: { runId: string; outcome: RunTerminalState }) => {
			await repos.runs.markRunning(input.runId, new Date("2026-05-08T12:00:01.000Z"));
			await repos.runs.finalize(input.runId, input.outcome, new Date("2026-05-08T12:00:02.000Z"));
			return {
				state: input.outcome,
				mulchUpdated: 0,
				mulchSkipped: 0,
				mulchAppended: 0,
				seedsClosed: 0,
				seedsCreated: 0,
				branchPushed: false,
				errors: [],
				alreadyTerminal: false,
			};
		}) as never;

		// A provider whose `status()` reports the run's terminal phase; the run
		// command's default terminal-state read must dispatch through it (warren-11cc).
		const provider = fakeProvider();
		let statusHandle: unknown;
		const providerWithStatus: RuntimeProvider = {
			...provider,
			status: (async (handle: unknown) => {
				statusHandle = handle;
				return {
					phase: "succeeded",
					exitCode: 0,
					lastEventSeq: 0,
					lastEventTs: null,
					exists: true,
				};
			}) as never,
		};

		const result = await runRun(
			context,
			{
				repos,
				runtimeProvider: providerWithStatus,
				broker,
				spawn: buildSpawnStub(repos, "refactor-bot", projectId) as never,
				bridge: bridgeStub,
				reap: reapStub,
			},
			{ agent: "refactor-bot", project: projectId, prompt: "fix the bug" },
		);

		expect(result.exitCode).toBe(0);
		expect(result.state).toBe("succeeded");
		// The handle carried the burrow sandbox + run ids the spawn stub attached.
		expect(statusHandle).toMatchObject({
			sandboxId: "bur_aaaaaaaaaaaa",
			providerRunId: "run_zzzzzzzzzzzz",
		});
	});
});

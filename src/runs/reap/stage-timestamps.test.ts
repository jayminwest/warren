import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reapRun } from "./run.ts";
import {
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	reapDeps,
} from "./test-helpers.ts";

/**
 * warren-7116: the stage-timestamp writers. Each column of the run wall
 * clock must stamp at its own edge, in order:
 *
 *   workspace_ready_at < agent_ready_at < agent_ended_at < reaped_at <= ended_at
 *
 * `ended_at` keeps its pre-existing semantics (stamped at finalize, after
 * push/PR/salvage) — these tests pin that ordering too, since the whole
 * point of the new columns is that ended_at silently absorbs the reap span.
 */

describe("runs stage timestamps (warren-7116)", () => {
	let db: Awaited<ReturnType<typeof import("../../db/client.ts").openDatabase>>;
	let repos: Awaited<ReturnType<typeof createRepos>>;

	beforeEach(async () => {
		const { openDatabase } = await import("../../db/client.ts");
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});
	afterEach(async () => {
		await db.close();
	});

	test("the writers stamp their edges in order along the run lifecycle", async () => {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "run_stageorder0000",
		});
		const created = await repos.runs.require(run.id);
		expect(created.workspaceReadyAt).toBeNull();
		expect(created.agentReadyAt).toBeNull();
		expect(created.agentEndedAt).toBeNull();
		expect(created.reapedAt).toBeNull();

		// Edge 1 — workspace ready (local drive after prepareSpawn / k8s
		// init-container done). The runtime fires the signal; the domain
		// stamps.
		const t1 = new Date("2026-07-12T00:00:01Z");
		await repos.runs.markWorkspaceReady(run.id, t1);

		// Edge 2 — the event bridge claims the run on its first event.
		const t2 = new Date("2026-07-12T00:00:02Z");
		const claimed = await repos.runs.claimById(run.id, t2);
		expect(claimed).not.toBeNull();
		expect(claimed?.agentReadyAt).toBe(t2.toISOString());
		// The claim instant IS the startedAt instant (same semantics).
		expect(claimed?.startedAt).toBe(t2.toISOString());

		// Edge 3 + 4 — runtime-terminal detected (reapRun entry), then the
		// terminal transition. A controlled clock makes the ordering
		// deterministic; each reap tick advances one second.
		let tick = 3;
		const now = (): Date => new Date(`2026-07-12T00:00:${String(tick++).padStart(2, "0")}Z`);
		await reapRun({
			runId: run.id,
			outcome: "failed",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
			now,
		});

		const row = await repos.runs.require(run.id);
		expect(row.workspaceReadyAt).toBe(t1.toISOString());
		expect(row.agentReadyAt).toBe(t2.toISOString());
		expect(row.agentEndedAt).toBeDefined();
		expect(row.reapedAt).toBeDefined();
		expect(row.endedAt).toBeDefined();
		expect(
			[row.workspaceReadyAt, row.agentReadyAt, row.agentEndedAt, row.reapedAt, row.endedAt].every(
				(ts): ts is string => ts !== null,
			),
		).toBe(true);
		const [t1x, t2x, t3, t4, t5] = [
			row.workspaceReadyAt,
			row.agentReadyAt,
			row.agentEndedAt,
			row.reapedAt,
			row.endedAt,
		] as [string, string, string, string, string];
		expect(Date.parse(t1x)).toBeLessThan(Date.parse(t2x));
		expect(Date.parse(t2x)).toBeLessThan(Date.parse(t3));
		expect(Date.parse(t3)).toBeLessThanOrEqual(Date.parse(t4));
		expect(Date.parse(t4)).toBeLessThanOrEqual(Date.parse(t5));
	});

	test("every writer is first-write-wins — a replay never overwrites the original observation", async () => {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_bbbbbbbbbbbb",
			sandboxRunId: "run_stageidempot000",
		});
		const t1 = new Date("2026-07-12T00:00:01Z");
		const later = new Date("2026-07-12T01:00:00Z");
		await repos.runs.markWorkspaceReady(run.id, t1);
		await repos.runs.markWorkspaceReady(run.id, later);
		await repos.runs.markAgentEnded(run.id, t1);
		await repos.runs.markAgentEnded(run.id, later);
		await repos.runs.markReaped(run.id, t1);
		await repos.runs.markReaped(run.id, later);

		const row = await repos.runs.require(run.id);
		expect(row.workspaceReadyAt).toBe(t1.toISOString());
		expect(row.agentEndedAt).toBe(t1.toISOString());
		expect(row.reapedAt).toBe(t1.toISOString());
	});

	test("agent_ended_at stays null for a run the bridge never claimed", async () => {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_cccccccccccc",
			sandboxRunId: "run_stageneverst000",
		});
		let tick = 0;
		const now = (): Date => new Date(1_000_000 + tick++);
		await reapRun({
			runId: run.id,
			outcome: "failed",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
			now,
		});
		const row = await repos.runs.require(run.id);
		// The agent never ran — no agent span to measure.
		expect(row.agentEndedAt).toBeNull();
		// But the reap still completed.
		expect(row.reapedAt).not.toBeNull();
	});
});

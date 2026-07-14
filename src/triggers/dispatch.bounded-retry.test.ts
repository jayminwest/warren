import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { CronTrigger } from "../warren-config/index.ts";
import { CronRetryTracker, MAX_CRON_TRANSIENT_RETRIES } from "./cron-retry.ts";
import { type DispatchSpawnFn, dispatchCronTrigger } from "./dispatch.ts";

const TRIGGER_ID = "nightly";

function cronTrigger(overrides: Partial<CronTrigger> = {}): CronTrigger {
	return {
		id: TRIGGER_ID,
		kind: "cron",
		cron: "0 0 * * *",
		seed: "warren-abc",
		role: "claude-code",
		...overrides,
	};
}

/**
 * Spawn stub that creates a real (queued) run row and returns its id — used to
 * assert the recovery / next-slot fire paths land a genuine run.
 */
function spawnRecorder(
	repos: Repos,
	projectId: string,
): { spawn: DispatchSpawnFn; calls: unknown[]; lastRunId(): string | null } {
	const calls: unknown[] = [];
	let lastRunId: string | null = null;
	const spawn: DispatchSpawnFn = async (input) => {
		calls.push({ agentName: input.agentName, trigger: input.trigger });
		const run = await repos.runs.create({
			agentName: input.agentName,
			projectId,
			prompt: input.prompt,
			renderedAgentJson: { sections: {} },
			trigger: input.trigger,
		});
		lastRunId = run.id;
		return { runId: run.id };
	};
	return { spawn, calls, lastRunId: () => lastRunId };
}

describe("dispatchCronTrigger bounded transient retries (warren-a0a2)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * Spawn stub that mimics `spawnRun`'s pre-dispatch failure: mint the run
	 * row, surface it via `onRowCreated`, finalize it `failed`/`never_started`
	 * (so `deleteNeverStarted`'s guard passes), then throw a transient error.
	 */
	function transientMintingSpawn(): { spawn: DispatchSpawnFn; minted: string[] } {
		const minted: string[] = [];
		const spawn: DispatchSpawnFn = async (input) => {
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger,
			});
			input.onRowCreated?.(run.id);
			await repos.runs.markRunning(run.id);
			await repos.runs.finalize(run.id, "failed", new Date(), "never_started");
			minted.push(run.id);
			throw new Error("burrow unreachable");
		};
		return { spawn, minted };
	}

	const deleteNeverStartedRun = async (runId: string): Promise<void> => {
		await repos.runs.deleteNeverStarted(runId);
	};

	async function neverStartedRunCount(): Promise<number> {
		const rows = await repos.runs.listAll({});
		return rows.filter((r) => r.state === "failed" && r.failureReason === "never_started").length;
	}

	async function seedSlot(): Promise<void> {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
	}

	test("gives up and consumes the slot after N consecutive transient failures", async () => {
		await seedSlot();
		const tracker = new CronRetryTracker();
		const { spawn, minted } = transientMintingSpawn();

		const results = [];
		for (let i = 0; i < MAX_CRON_TRANSIENT_RETRIES; i += 1) {
			results.push(
				await dispatchCronTrigger({
					projectId,
					trigger: cronTrigger(),
					// Each tick a minute apart, all within the same (daily) slot.
					now: new Date(`2026-05-11T00:0${5 + i}:00.000Z`),
					repos,
					spawn,
					retryTracker: tracker,
					deleteNeverStartedRun,
				}),
			);
		}

		// Attempts 1..N-1 stay `error` (retry next tick); the Nth gives up.
		for (let i = 0; i < MAX_CRON_TRANSIENT_RETRIES - 1; i += 1) {
			expect(results[i]?.kind).toBe("error");
		}
		const last = results[MAX_CRON_TRANSIENT_RETRIES - 1];
		expect(last?.kind).toBe("gave_up");
		if (last?.kind === "gave_up") {
			expect(last.attempts).toBe(MAX_CRON_TRANSIENT_RETRIES);
			expect(last.reason).toContain("consecutively");
		}

		// The slot is consumed: the row advanced to the give-up tick, so the
		// next tick within this slot would skip.
		const row = await repos.triggers.require({ projectId, triggerId: TRIGGER_ID });
		expect(row.lastFiredAt).toBe("2026-05-11T00:09:00.000Z");
		expect(row.nextFireAt).toBe("2026-05-12T00:00:00.000Z");
		expect(row.lastRunId).toBeNull();

		// Flood mitigation: exactly one never_started row survives the slot —
		// the last attempt — not one per tick. It is the operator-visible record.
		expect(await neverStartedRunCount()).toBe(1);
		const survivors = (await repos.runs.listAll({})).filter(
			(r) => r.failureReason === "never_started",
		);
		expect(survivors[0]?.id).toBe(minted[minted.length - 1]);
	});

	test("recovers within the cap and GCs every transient never_started row", async () => {
		await seedSlot();
		const tracker = new CronRetryTracker();
		const { spawn: failing } = transientMintingSpawn();

		// Two transient failures, still under the cap.
		for (let i = 0; i < 2; i += 1) {
			const r = await dispatchCronTrigger({
				projectId,
				trigger: cronTrigger(),
				now: new Date(`2026-05-11T00:0${5 + i}:00.000Z`),
				repos,
				spawn: failing,
				retryTracker: tracker,
				deleteNeverStartedRun,
			});
			expect(r.kind).toBe("error");
		}
		expect(await neverStartedRunCount()).toBe(1);

		// Third tick succeeds.
		const { spawn: succeeding, calls } = spawnRecorder(repos, projectId);
		const fired = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger(),
			now: new Date("2026-05-11T00:07:00.000Z"),
			repos,
			spawn: succeeding,
			retryTracker: tracker,
			deleteNeverStartedRun,
		});

		expect(fired.kind).toBe("fired");
		expect(calls).toHaveLength(1);
		// The lingering transient failure row is reclaimed — only the
		// successful run remains.
		expect(await neverStartedRunCount()).toBe(0);
		const row = await repos.triggers.require({ projectId, triggerId: TRIGGER_ID });
		expect(row.lastFiredAt).toBe("2026-05-11T00:07:00.000Z");
	});

	test("the next genuine slot fires normally after a give-up (slot-only consumption)", async () => {
		await seedSlot();
		const tracker = new CronRetryTracker();
		const { spawn: failing } = transientMintingSpawn();

		// Burn through the cap to give up on the 2026-05-11 slot.
		for (let i = 0; i < MAX_CRON_TRANSIENT_RETRIES; i += 1) {
			await dispatchCronTrigger({
				projectId,
				trigger: cronTrigger(),
				now: new Date(`2026-05-11T00:0${5 + i}:00.000Z`),
				repos,
				spawn: failing,
				retryTracker: tracker,
				deleteNeverStartedRun,
			});
		}

		// Runtime is healthy again by the next day's slot.
		const { spawn: succeeding, calls, lastRunId } = spawnRecorder(repos, projectId);
		const fired = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger(),
			now: new Date("2026-05-12T00:05:00.000Z"),
			repos,
			spawn: succeeding,
			retryTracker: tracker,
			deleteNeverStartedRun,
		});

		expect(fired.kind).toBe("fired");
		expect(calls).toHaveLength(1);
		const row = await repos.triggers.require({ projectId, triggerId: TRIGGER_ID });
		expect(row.lastRunId).toBe(lastRunId() ?? "");
		expect(row.lastFiredAt).toBe("2026-05-12T00:05:00.000Z");
	});

	test("without a retryTracker the legacy unbounded retry behaviour holds", async () => {
		await seedSlot();
		const { spawn } = transientMintingSpawn();
		// Far more attempts than the cap — every one stays `error`, row untouched.
		for (let i = 0; i < MAX_CRON_TRANSIENT_RETRIES + 3; i += 1) {
			const r = await dispatchCronTrigger({
				projectId,
				trigger: cronTrigger(),
				now: new Date("2026-05-11T00:05:00.000Z"),
				repos,
				spawn,
			});
			expect(r.kind).toBe("error");
		}
		const row = await repos.triggers.require({ projectId, triggerId: TRIGGER_ID });
		expect(row.lastFiredAt).toBe("2026-05-10T12:00:00.000Z");
	});
});

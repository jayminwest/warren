import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { ScheduledSeed } from "../seeds-cli/index.ts";
import type { CronTrigger, DefaultsConfig } from "../warren-config/index.ts";
import { type DispatchSpawnFn, dispatchCronTrigger, dispatchScheduledSeed } from "./dispatch.ts";

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

interface RecordedSpawn {
	agentName: string;
	prompt: string;
	trigger: string;
	metadata?: unknown;
	maxCostUsd?: number;
}

/**
 * Spawn stub that creates a real run row so `triggers.last_run_id` FK is
 * satisfied. The dispatcher writes the spawned run id into the triggers
 * table; without a backing row the FK would fail and mask the test's
 * intent.
 */
function spawnRecorder(
	repos: Repos,
	projectId: string,
): {
	spawn: DispatchSpawnFn;
	calls: RecordedSpawn[];
	lastRunId(): string | null;
} {
	const calls: RecordedSpawn[] = [];
	let lastRunId: string | null = null;
	const spawn: DispatchSpawnFn = async (input) => {
		calls.push({
			agentName: input.agentName,
			prompt: input.prompt,
			trigger: input.trigger,
			metadata: input.metadata,
			...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
		});
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

function spawnFailure(message: string): DispatchSpawnFn {
	return async () => {
		throw new Error(message);
	};
}

describe("dispatchCronTrigger", () => {
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

	test("first observation seeds the row at now and does NOT fire", async () => {
		const { spawn, calls } = spawnRecorder(repos, projectId);
		const now = new Date("2026-05-10T12:30:00.000Z");
		const result = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger(),
			now,
			repos,
			spawn,
		});

		expect(result.kind).toBe("seeded");
		expect(calls).toHaveLength(0);
		const row = await repos.triggers.require({ projectId, triggerId: TRIGGER_ID });
		expect(row.lastFiredAt).toBe(now.toISOString());
		expect(row.nextFireAt).toBe("2026-05-11T00:00:00.000Z");
	});

	test("subsequent tick fires once when previousRun > lastFiredAt", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});

		const { spawn, calls, lastRunId } = spawnRecorder(repos, projectId);
		const now = new Date("2026-05-11T00:05:00.000Z");
		const result = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger(),
			now,
			repos,
			spawn,
		});

		expect(result.kind).toBe("fired");
		if (result.kind !== "fired") return;
		expect(result.runId).toBe(lastRunId() ?? "");
		expect(calls).toEqual([
			{
				agentName: "claude-code",
				prompt: "Work on seed warren-abc (cron trigger nightly).",
				trigger: "cron",
				metadata: { triggerId: TRIGGER_ID, cron: "0 0 * * *", seed: "warren-abc" },
			},
		]);

		const row = await repos.triggers.require({ projectId, triggerId: TRIGGER_ID });
		expect(row.lastFiredAt).toBe(now.toISOString());
		expect(row.lastRunId).toBe(lastRunId() ?? "");
		expect(row.nextFireAt).toBe("2026-05-12T00:00:00.000Z");
	});

	test("forwards the trigger's maxCostUsd to the spawn input when fired", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const { spawn, calls } = spawnRecorder(repos, projectId);
		const result = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger({ maxCostUsd: 5 }),
			now: new Date("2026-05-11T00:05:00.000Z"),
			repos,
			spawn,
		});
		expect(result.kind).toBe("fired");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.maxCostUsd).toBe(5);
	});

	test("omits maxCostUsd from the spawn input when the trigger declares none", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const { spawn, calls } = spawnRecorder(repos, projectId);
		await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger(),
			now: new Date("2026-05-11T00:05:00.000Z"),
			repos,
			spawn,
		});
		expect(calls[0]?.maxCostUsd).toBeUndefined();
	});

	test("no-catch-up: a 4-hour outage on an hourly trigger fires exactly once", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});

		const { spawn, calls } = spawnRecorder(repos, projectId);
		// Hourly cron; we last fired at 12:00, "outage" from 12:01-16:30.
		const now = new Date("2026-05-10T16:30:00.000Z");
		const result = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger({ cron: "0 * * * *" }),
			now,
			repos,
			spawn,
		});

		expect(result.kind).toBe("fired");
		expect(calls).toHaveLength(1);
		const row = await repos.triggers.require({ projectId, triggerId: TRIGGER_ID });
		expect(row.lastFiredAt).toBe(now.toISOString());
	});

	test("does not double-fire on a rapid tick after a fire", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-11T00:05:00.000Z",
		});

		const { spawn, calls } = spawnRecorder(repos, projectId);
		const now = new Date("2026-05-11T00:05:30.000Z");
		const result = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger(),
			now,
			repos,
			spawn,
		});

		expect(result.kind).toBe("skipped");
		expect(calls).toHaveLength(0);
	});

	test("returns error result for an unparseable cron expression", async () => {
		const { spawn, calls } = spawnRecorder(repos, projectId);
		const result = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger({ cron: "totally not a cron" }),
			now: new Date("2026-05-11T00:00:00.000Z"),
			repos,
			spawn,
		});
		expect(result.kind).toBe("error");
		expect(calls).toHaveLength(0);
	});

	test("spawn failure leaves the warren row untouched so the next tick retries", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const result = await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger(),
			now: new Date("2026-05-11T00:05:00.000Z"),
			repos,
			spawn: spawnFailure("burrow unreachable"),
		});
		expect(result.kind).toBe("error");

		const row = await repos.triggers.require({ projectId, triggerId: TRIGGER_ID });
		expect(row.lastFiredAt).toBe("2026-05-10T12:00:00.000Z");
		expect(row.lastRunId).toBeNull();
	});

	test("explicit trigger.prompt overrides the canonical fallback", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const { spawn, calls } = spawnRecorder(repos, projectId);
		await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger({ prompt: "Run nightly cleanup." }),
			now: new Date("2026-05-11T00:05:00.000Z"),
			repos,
			spawn,
		});
		expect(calls[0]?.prompt).toBe("Run nightly cleanup.");
	});

	test("defaults.defaultPrompt is used when trigger has no explicit prompt", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const defaults: DefaultsConfig = { defaultPrompt: "Default cron body." };
		const { spawn, calls } = spawnRecorder(repos, projectId);
		await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger(),
			defaults,
			now: new Date("2026-05-11T00:05:00.000Z"),
			repos,
			spawn,
		});
		expect(calls[0]?.prompt).toBe("Default cron body.");
	});

	test("seedless trigger uses generic fallback prompt and omits seed from metadata", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: TRIGGER_ID,
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const { spawn, calls } = spawnRecorder(repos, projectId);
		await dispatchCronTrigger({
			projectId,
			trigger: cronTrigger({ seed: undefined }),
			now: new Date("2026-05-11T00:05:00.000Z"),
			repos,
			spawn,
		});
		expect(calls[0]?.prompt).toBe("Run cron trigger nightly.");
		const meta = calls[0]?.metadata as Record<string, unknown>;
		expect(meta.seed).toBeUndefined();
	});
});

describe("dispatchScheduledSeed", () => {
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

	function seed(scheduledFor: string, status = "open", id = "warren-s1"): ScheduledSeed {
		return { id, status, scheduledFor: new Date(scheduledFor), title: "sched seed" };
	}

	test("skips a seed scheduled in the future", async () => {
		const { spawn, calls } = spawnRecorder(repos, projectId);
		const result = await dispatchScheduledSeed({
			projectId,
			seed: seed("2026-06-01T00:00:00.000Z"),
			defaults: { defaultRole: "claude-code" },
			now: new Date("2026-05-10T12:00:00.000Z"),
			spawn,
		});
		expect(result.kind).toBe("skipped");
		expect(calls).toHaveLength(0);
	});

	test("dispatches a past-due seed with trigger='scheduled' and surfaces the resolved role", async () => {
		const { spawn, calls, lastRunId } = spawnRecorder(repos, projectId);
		const result = await dispatchScheduledSeed({
			projectId,
			seed: seed("2026-05-10T10:00:00.000Z"),
			defaults: { defaultRole: "claude-code", defaultPrompt: "Sched body." },
			now: new Date("2026-05-10T12:00:00.000Z"),
			spawn,
		});
		expect(result.kind).toBe("fired");
		if (result.kind !== "fired") return;
		expect(result.runId).toBe(lastRunId() ?? "");
		// pl-bb70 step 5: role is exposed on the fired result so the tick's
		// post-fire updateExtensions merge can include `role` alongside
		// `{trigger:'scheduled', lastRunId, lastRunAt, scheduledFor:null,
		// lastScheduledRun}` in a single sd update.
		expect(result.role).toBe("claude-code");
		expect(calls[0]?.trigger).toBe("scheduled");
		expect(calls[0]?.agentName).toBe("claude-code");
		expect(calls[0]?.prompt).toBe("Sched body.");
	});

	test("falls back to canonical prompt when no defaultPrompt is set", async () => {
		const { spawn, calls } = spawnRecorder(repos, projectId);
		await dispatchScheduledSeed({
			projectId,
			seed: seed("2026-05-10T10:00:00.000Z"),
			defaults: { defaultRole: "claude-code" },
			now: new Date("2026-05-10T12:00:00.000Z"),
			spawn,
		});
		expect(calls[0]?.prompt).toBe("Work on seed warren-s1 (sched seed).");
	});

	test("returns error when defaults.defaultRole is missing", async () => {
		const { spawn, calls } = spawnRecorder(repos, projectId);
		const result = await dispatchScheduledSeed({
			projectId,
			seed: seed("2026-05-10T10:00:00.000Z"),
			defaults: {},
			now: new Date("2026-05-10T12:00:00.000Z"),
			spawn,
		});
		expect(result.kind).toBe("error");
		expect(calls).toHaveLength(0);
	});

	test("returns error when spawn throws", async () => {
		const result = await dispatchScheduledSeed({
			projectId,
			seed: seed("2026-05-10T10:00:00.000Z"),
			defaults: { defaultRole: "claude-code" },
			now: new Date("2026-05-10T12:00:00.000Z"),
			spawn: spawnFailure("boom"),
		});
		expect(result.kind).toBe("error");
	});
});

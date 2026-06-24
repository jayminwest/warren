import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { ScheduledSeed } from "../seeds-cli/index.ts";
import { type DispatchSpawnFn, dispatchScheduledSeed } from "./dispatch.ts";

interface RecordedSpawn {
	agentName: string;
	prompt: string;
	trigger: string;
	metadata?: unknown;
	maxCostUsd?: number;
}

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

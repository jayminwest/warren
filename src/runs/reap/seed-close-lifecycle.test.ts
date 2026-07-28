/**
 * Clone-side seed-close observation-bus subscriber (warren-df3e).
 *
 * Exercises the extension in isolation: it observes `post_reap` and runs the
 * idempotent host-side `sd close` against the project clone only when the reap
 * settled `succeeded` with a pushed branch, the run carries a seed id, and the
 * project has seeds. It resolves run/project/seedsCli itself (the payload stays
 * within the frozen warren-ext/v1 shape — no seed id, no clone path). The
 * handler is invoked directly and awaited so the fire-and-forget bus dispatch
 * does not race the assertions.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import {
	type LifecycleEnvelope,
	type PostReapPayload,
	WARREN_EXT_PROTOCOL,
} from "../lifecycle-bus.ts";
import { createSeedCloseLifecycleExtension } from "./seed-close-lifecycle.ts";

/** Build a SeedsCliDeps stub whose `spawn` tracks calls and returns exit 0. */
function fakeSeedsCli(opts: { exitCode?: number } = {}): {
	seedsCli: SeedsCliDeps;
	calls: Array<{ args: string[]; cwd: string }>;
} {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const seedsCli: SeedsCliDeps = {
		sdBinary: "sd",
		spawn: async (args, spawnOpts) => {
			calls.push({ args: args as string[], cwd: spawnOpts?.cwd ?? "" });
			const exitCode = opts.exitCode ?? 0;
			return { exitCode, stdout: "", stderr: exitCode !== 0 ? "error" : "" };
		},
	};
	return { seedsCli, calls };
}

function recordingLogger() {
	const lines: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
	return {
		lines,
		logger: {
			error: (obj: Record<string, unknown>, msg?: string) => void lines.push({ obj, msg }),
		},
	};
}

let openDb: WarrenDb | null = null;
afterEach(() => {
	openDb?.close();
	openDb = null;
});

async function setup(opts: { seedId?: string | null; hasSeeds?: boolean } = {}): Promise<{
	repos: ReturnType<typeof createRepos>;
	runId: string;
	projectId: string;
}> {
	const db = await openDatabase({ path: ":memory:" });
	openDb = db;
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: { sections: { system: "x" } } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
		hasSeeds: opts.hasSeeds ?? true,
	});
	const seedId = opts.seedId === undefined ? "sd-target" : opts.seedId;
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		burrowId: "bur_aaaaaaaaaaaa",
		burrowRunId: "run_zzzzzzzzzzzz",
		...(seedId !== null ? { seedId } : {}),
	});
	await repos.runs.markRunning(run.id);
	return { repos, runId: run.id, projectId: project.id };
}

function envelope(
	payload: Partial<PostReapPayload> & { runId: string },
): LifecycleEnvelope<"post_reap"> {
	return {
		protocol: WARREN_EXT_PROTOCOL,
		hook: "post_reap",
		runId: payload.runId,
		at: "2026-07-28T00:00:00.000Z",
		payload: {
			runId: payload.runId,
			projectId: payload.projectId ?? "",
			outcome: payload.outcome ?? "succeeded",
			branchPushed: payload.branchPushed ?? true,
			commitsAhead: payload.commitsAhead ?? 3,
			prUrl: payload.prUrl ?? null,
		},
	};
}

async function fire(
	repos: ReturnType<typeof createRepos>,
	seedsCli: SeedsCliDeps,
	logger: ReturnType<typeof recordingLogger>["logger"],
	payload: Partial<PostReapPayload> & { runId: string },
): Promise<void> {
	const ext = createSeedCloseLifecycleExtension({ repos, seedsCli, logger });
	await ext.hooks.post_reap?.(envelope(payload));
}

describe("createSeedCloseLifecycleExtension", () => {
	test("negotiates warren-ext/v1 and subscribes to post_reap only", () => {
		const { logger } = recordingLogger();
		const { seedsCli } = fakeSeedsCli();
		const ext = createSeedCloseLifecycleExtension({
			repos: {} as ReturnType<typeof createRepos>,
			seedsCli,
			logger,
		});
		expect(ext.name).toBe("seed-close");
		expect(ext.protocol).toBe(WARREN_EXT_PROTOCOL);
		expect(Object.keys(ext.hooks)).toEqual(["post_reap"]);
	});

	test("closes the run seed via sd close on a succeeded, pushed reap", async () => {
		const { repos, runId, projectId } = await setup();
		const { seedsCli, calls } = fakeSeedsCli();
		const { logger } = recordingLogger();
		await fire(repos, seedsCli, logger, { runId, projectId });

		const closeCall = calls.find((c) => c.args.includes("close") && c.args.includes("sd-target"));
		expect(closeCall).toBeDefined();
		expect(closeCall?.cwd).toBe("/data/projects/x/y");
		const events = await repos.events.listByRun(runId);
		expect(events.find((ev) => ev.kind === "seeds.seed_id_closed")).toBeDefined();
	});

	test("skips when the run carries no seed id", async () => {
		const { repos, runId, projectId } = await setup({ seedId: null });
		const { seedsCli, calls } = fakeSeedsCli();
		const { logger } = recordingLogger();
		await fire(repos, seedsCli, logger, { runId, projectId });
		expect(calls.some((c) => c.args.includes("close"))).toBe(false);
	});

	test("skips when the reap outcome is not succeeded", async () => {
		const { repos, runId, projectId } = await setup();
		const { seedsCli, calls } = fakeSeedsCli();
		const { logger } = recordingLogger();
		await fire(repos, seedsCli, logger, { runId, projectId, outcome: "failed" });
		expect(calls.some((c) => c.args.includes("close"))).toBe(false);
	});

	test("skips when the branch was not pushed", async () => {
		const { repos, runId, projectId } = await setup();
		const { seedsCli, calls } = fakeSeedsCli();
		const { logger } = recordingLogger();
		await fire(repos, seedsCli, logger, { runId, projectId, branchPushed: false });
		expect(calls.some((c) => c.args.includes("close"))).toBe(false);
	});

	test("skips when the project has no seeds", async () => {
		const { repos, runId, projectId } = await setup({ hasSeeds: false });
		const { seedsCli, calls } = fakeSeedsCli();
		const { logger } = recordingLogger();
		await fire(repos, seedsCli, logger, { runId, projectId });
		expect(calls.some((c) => c.args.includes("close"))).toBe(false);
	});

	test("logs seed-close.failed and never throws when sd close fails", async () => {
		const { repos, runId, projectId } = await setup();
		const { seedsCli } = fakeSeedsCli({ exitCode: 1 });
		const { lines, logger } = recordingLogger();
		await fire(repos, seedsCli, logger, { runId, projectId });
		expect(lines.find((l) => l.msg === "seed-close.failed")).toBeDefined();
	});
});

/**
 * Clone-side seed-close observation-bus subscriber (warren-df3e).
 *
 * Exercises the extension in isolation: it observes `post_reap` and runs the
 * idempotent host-side `sd close` against the project clone only when the reap
 * settled `succeeded` with a pushed branch, the run carries a seed id, and the
 * project has seeds. It resolves run/project/tracker itself (the payload stays
 * within the frozen warren-ext/v1 shape — no seed id, no clone path). The
 * handler is invoked directly and awaited so the fire-and-forget bus dispatch
 * does not race the assertions.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import {
	type LifecycleEnvelope,
	type PostReapPayload,
	WARREN_EXT_PROTOCOL,
} from "../lifecycle-bus.ts";
import { createSeedCloseLifecycleExtension } from "./seed-close-lifecycle.ts";

/** Build a fake IssueTracker whose closeIssue records calls (warren-6234). */
function fakeTracker(opts: { fail?: boolean } = {}): {
	issueTracker: IssueTracker;
	calls: Array<{ seedId: string; projectId: string; localPath?: string }>;
} {
	const calls: Array<{ seedId: string; projectId: string; localPath?: string }> = [];
	const issueTracker: IssueTracker = {
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
		closeIssue: async (_ctx, seedId) => {
			calls.push({ seedId, projectId: _ctx.projectId, localPath: _ctx.localPath });
			if (opts.fail) throw new Error("close exit 1");
		},
	};
	return { issueTracker, calls };
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
		sandboxId: "bur_aaaaaaaaaaaa",
		sandboxRunId: "run_zzzzzzzzzzzz",
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
	issueTracker: IssueTracker,
	logger: ReturnType<typeof recordingLogger>["logger"],
	payload: Partial<PostReapPayload> & { runId: string },
): Promise<void> {
	const ext = createSeedCloseLifecycleExtension({ repos, issueTracker, logger });
	await ext.hooks.post_reap?.(envelope(payload));
}

describe("createSeedCloseLifecycleExtension", () => {
	test("negotiates warren-ext/v1 and subscribes to post_reap only", () => {
		const { logger } = recordingLogger();
		const { issueTracker } = fakeTracker();
		const ext = createSeedCloseLifecycleExtension({
			repos: {} as ReturnType<typeof createRepos>,
			issueTracker,
			logger,
		});
		expect(ext.name).toBe("seed-close");
		expect(ext.protocol).toBe(WARREN_EXT_PROTOCOL);
		expect(Object.keys(ext.hooks)).toEqual(["post_reap"]);
	});

	test("closes the run seed via tracker.closeIssue on a succeeded, pushed reap", async () => {
		const { repos, runId, projectId } = await setup();
		const { issueTracker, calls } = fakeTracker();
		const { logger } = recordingLogger();
		await fire(repos, issueTracker, logger, { runId, projectId });

		expect(calls).toEqual([{ seedId: "sd-target", projectId, localPath: "/data/projects/x/y" }]);
		const events = await repos.events.listByRun(runId);
		expect(events.find((ev) => ev.kind === "seeds.seed_id_closed")).toBeDefined();
	});

	test("skips when the run carries no seed id", async () => {
		const { repos, runId, projectId } = await setup({ seedId: null });
		const { issueTracker, calls } = fakeTracker();
		const { logger } = recordingLogger();
		await fire(repos, issueTracker, logger, { runId, projectId });
		expect(calls).toHaveLength(0);
	});

	test("skips when the reap outcome is not succeeded", async () => {
		const { repos, runId, projectId } = await setup();
		const { issueTracker, calls } = fakeTracker();
		const { logger } = recordingLogger();
		await fire(repos, issueTracker, logger, { runId, projectId, outcome: "failed" });
		expect(calls).toHaveLength(0);
	});

	test("skips when the branch was not pushed", async () => {
		const { repos, runId, projectId } = await setup();
		const { issueTracker, calls } = fakeTracker();
		const { logger } = recordingLogger();
		await fire(repos, issueTracker, logger, { runId, projectId, branchPushed: false });
		expect(calls).toHaveLength(0);
	});

	test("skips when the pushed branch has no commits", async () => {
		const { repos, runId, projectId } = await setup();
		const { issueTracker, calls } = fakeTracker();
		const { logger } = recordingLogger();
		await fire(repos, issueTracker, logger, { runId, projectId, commitsAhead: 0 });
		expect(calls).toHaveLength(0);
		const events = await repos.events.listByRun(runId);
		expect(events.some((ev) => ev.kind === "seeds.seed_id_closed")).toBe(false);
	});

	test("skips when the project has no seeds", async () => {
		const { repos, runId, projectId } = await setup({ hasSeeds: false });
		const { issueTracker, calls } = fakeTracker();
		const { logger } = recordingLogger();
		await fire(repos, issueTracker, logger, { runId, projectId });
		expect(calls).toHaveLength(0);
	});

	test("logs seed-close.failed and never throws when sd close fails", async () => {
		const { repos, runId, projectId } = await setup();
		const { issueTracker } = fakeTracker({ fail: true });
		const { lines, logger } = recordingLogger();
		await fire(repos, issueTracker, logger, { runId, projectId });
		expect(lines.find((l) => l.msg === "seed-close.failed")).toBeDefined();
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import type { LifecycleEnvelope } from "../lifecycle-bus.ts";
import { WARREN_EXT_PROTOCOL } from "../lifecycle-bus.ts";
import type { PrMergeChecker, PrMergePollResult } from "../pr-merge.ts";
import { createPrMergeWatcher, type PrMergeWatcher } from "./pr-merge-watcher.ts";

interface LoggedLine {
	readonly level: "warn" | "error";
	readonly obj: object;
	readonly msg: string;
}

function recordingLogger() {
	const lines: LoggedLine[] = [];
	const push = (level: LoggedLine["level"]) => (obj: object, msg: string) =>
		void lines.push({ level, obj, msg });
	return { lines, logger: { warn: push("warn"), error: push("error") } };
}

/** A checker that answers from a scripted queue, then repeats the last. */
function scriptedChecker(script: PrMergePollResult[]): {
	checker: PrMergeChecker;
	calls: () => number;
} {
	let calls = 0;
	return {
		calls: () => calls,
		checker: async () => {
			calls += 1;
			const next = script.length > 1 ? script.shift() : script[0];
			return next ?? { kind: "open" };
		},
	};
}

function postReapEnvelope(runId: string, prUrl: string | null): LifecycleEnvelope<"post_reap"> {
	return {
		protocol: WARREN_EXT_PROTOCOL,
		hook: "post_reap",
		runId,
		at: new Date().toISOString(),
		payload: {
			runId,
			projectId: "proj",
			outcome: "succeeded",
			branchPushed: true,
			commitsAhead: 1,
			prUrl,
		},
	};
}

const noopSleep = () => Promise.resolve();

/** Wait until `cond` holds, polling on a real 1ms timer. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

// The watcher never dereferences the forge when a checker is injected.
const unusedForge = {} as Forge;

describe("createPrMergeWatcher", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;
	let watcher: PrMergeWatcher | undefined;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});
	afterEach(() => {
		watcher?.stop();
		watcher = undefined;
		db.close();
	});

	async function spawnRun(prUrl: string | null = null) {
		const run = await repos.runs.create({
			agentName: "a",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		if (prUrl !== null) await repos.runs.setPrUrl(run.id, prUrl);
		return run;
	}

	function build(checker: PrMergeChecker) {
		const { lines, logger } = recordingLogger();
		watcher = createPrMergeWatcher({
			repos,
			forge: unusedForge,
			logger,
			checker,
			sleep: noopSleep,
			initialIntervalMs: 0,
		});
		return lines;
	}

	test("post_reap with a merged PR writes pr_state + pr_merged_at and stops", async () => {
		const run = await spawnRun();
		const { checker, calls } = scriptedChecker([
			{ kind: "merged", mergedAt: "2026-08-14T01:02:03.000Z" },
		]);
		build(checker);
		watcher?.extension.hooks.post_reap?.(postReapEnvelope(run.id, "https://github.com/x/y/pull/9"));
		await waitFor(() => watcher?.watching === 0);
		const row = await repos.runs.get(run.id);
		expect(row?.prState).toBe("merged");
		expect(row?.prMergedAt).toBe("2026-08-14T01:02:03.000Z");
		expect(calls()).toBe(1);
	});

	test("an open PR is stamped open, re-polled on backoff, then settled merged", async () => {
		const run = await spawnRun();
		const { checker, calls } = scriptedChecker([
			{ kind: "open" },
			{ kind: "open" },
			{ kind: "merged", mergedAt: "2026-08-14T02:00:00.000Z" },
		]);
		build(checker);
		watcher?.adopt(run.id, "https://github.com/x/y/pull/10");
		await waitFor(() => watcher?.watching === 0);
		expect(calls()).toBe(3);
		const row = await repos.runs.get(run.id);
		expect(row?.prState).toBe("merged");
		expect(row?.prMergedAt).toBe("2026-08-14T02:00:00.000Z");
	});

	test("closed_unmerged is terminal and leaves pr_merged_at null", async () => {
		const run = await spawnRun();
		const { checker, calls } = scriptedChecker([{ kind: "open" }, { kind: "closed_unmerged" }]);
		build(checker);
		watcher?.adopt(run.id, "https://github.com/x/y/pull/11");
		await waitFor(() => watcher?.watching === 0);
		expect(calls()).toBe(2);
		const row = await repos.runs.get(run.id);
		expect(row?.prState).toBe("closed_unmerged");
		expect(row?.prMergedAt).toBeNull();
	});

	test("unparseable stops polling and leaves pr_state NULL (unknown, not failure)", async () => {
		const run = await spawnRun();
		const { checker, calls } = scriptedChecker([
			{ kind: "unparseable", detail: "no forge owns pull request url" },
		]);
		const lines = build(checker);
		watcher?.adopt(run.id, "https://gitlab.example.com/x/y/-/merge_requests/1");
		await waitFor(() => watcher?.watching === 0);
		expect(calls()).toBe(1);
		expect((await repos.runs.get(run.id))?.prState).toBeNull();
		expect(lines.some((l) => l.msg === "pr_merge_watch.unparseable")).toBe(true);
	});

	test("not_found is fatal; transient forge errors keep polling", async () => {
		const gone = await spawnRun();
		const fatal = scriptedChecker([
			{ kind: "forge_error", errorKind: "not_found", detail: "gone" },
		]);
		build(fatal.checker);
		watcher?.adopt(gone.id, "https://github.com/x/y/pull/12");
		await waitFor(() => watcher?.watching === 0);
		expect(fatal.calls()).toBe(1);
		expect((await repos.runs.get(gone.id))?.prState).toBeNull();

		const flaky = await spawnRun();
		const transient = scriptedChecker([
			{ kind: "forge_error", errorKind: "rate_limited", detail: "slow down" },
			{ kind: "merged", mergedAt: "2026-08-14T03:00:00.000Z" },
		]);
		build(transient.checker);
		watcher?.adopt(flaky.id, "https://github.com/x/y/pull/13");
		await waitFor(() => watcher?.watching === 0);
		expect(transient.calls()).toBe(2);
		expect((await repos.runs.get(flaky.id))?.prState).toBe("merged");
	});

	test("post_reap without a prUrl adopts nothing", async () => {
		const run = await spawnRun();
		const { checker, calls } = scriptedChecker([{ kind: "open" }]);
		build(checker);
		watcher?.extension.hooks.post_reap?.(postReapEnvelope(run.id, null));
		expect(watcher?.watching).toBe(0);
		expect(calls()).toBe(0);
	});

	test("adopting the same run twice is a no-op", async () => {
		const run = await spawnRun();
		const { checker, calls } = scriptedChecker([
			{ kind: "merged", mergedAt: "2026-08-14T04:00:00.000Z" },
		]);
		build(checker);
		watcher?.adopt(run.id, "https://github.com/x/y/pull/14");
		watcher?.adopt(run.id, "https://github.com/x/y/pull/14");
		await waitFor(() => watcher?.watching === 0);
		expect(calls()).toBe(1);
	});

	test("a watch expires after the budget instead of polling forever", async () => {
		const run = await spawnRun();
		const { checker, calls } = scriptedChecker([{ kind: "open" }]);
		const { logger } = recordingLogger();
		let tick = 0;
		watcher = createPrMergeWatcher({
			repos,
			forge: unusedForge,
			logger,
			checker,
			sleep: noopSleep,
			initialIntervalMs: 0,
			maxIntervalMs: 1_000,
			maxWatchMs: 5_000,
			now: () => {
				tick += 2_000;
				return new Date(1_000_000 + tick);
			},
		});
		watcher.adopt(run.id, "https://github.com/x/y/pull/15");
		await waitFor(() => watcher?.watching === 0);
		expect(calls()).toBeGreaterThan(0);
		expect(calls()).toBeLessThan(10);
		// Budget expiry leaves pr_state at its last observed value ("open").
		expect((await repos.runs.get(run.id))?.prState).toBe("open");
	});
});

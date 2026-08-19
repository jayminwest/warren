import { describe, expect, test } from "bun:test";
import type { Issue, IssueTracker, TrackerContext } from "../../tracker/contract.ts";
import { gatherPrContext } from "./pr-context.ts";
import type { ReapExec } from "./types.ts";

/**
 * warren-50c8: PR seed attribution reads the run row's authoritative `seedId`.
 * The prompt regex scan survives only as a fallback for legacy/manual runs
 * dispatched without one, and it now refuses ambiguous prompts.
 *
 * warren-47b0: the seed read goes through the IssueTracker seam
 * (`tracker.getIssue`), never a hardcoded `sd` spawn — the exec below throws
 * on ANY spawn so a regression back to `exec.run("sd", ...)` fails loudly.
 */

interface Recorder {
	readonly tracker: IssueTracker;
	readonly shown: string[];
}

function recordingTracker(titles: Record<string, string> = {}): Recorder {
	const shown: string[] = [];
	const tracker: IssueTracker = {
		capabilities: {
			supportsPlans: true,
			supportsMetadata: true,
			supportsScheduledIssues: true,
			isGitNative: true,
		},
		getIssue: async (_ctx: TrackerContext, issueId: string): Promise<Issue> => {
			shown.push(issueId);
			const title = titles[issueId];
			if (title === undefined) throw new Error(`Issue not found: ${issueId}`);
			return { id: issueId, status: "open", title };
		},
		listIssueStatuses: async () => new Map(),
		closeIssue: async () => {},
	};
	return { tracker, shown };
}

/** An exec that refuses to spawn anything — the seed read must not shell out. */
const noSpawnExec: ReapExec = {
	run: async (cmd) => {
		throw new Error(`unexpected exec.spawn: ${cmd}`);
	},
};

const BASE = {
	// No host workspace and no cloneFetch: commit/diff-stat sections degrade to
	// empty, so the tracker read is the only thing these tests exercise.
	workspacePath: null,
	projectPath: "/tmp/project",
	baseBranch: "main",
	exec: noSpawnExec,
} as const;

describe("gatherPrContext seed attribution", () => {
	test("prefers run.seedId over other seed ids mentioned in the prompt", async () => {
		const rec = recordingTracker({ "warren-50c8": "the real issue" });
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "Work seeds issue warren-8cbf, but see warren-e14e for context.",
			seedId: "warren-50c8",
			issueTracker: rec.tracker,
		});
		expect(ctx.seed).toEqual({ id: "warren-50c8", title: "the real issue" });
		expect(rec.shown).toEqual(["warren-50c8"]);
	});

	test("falls back to the prompt scan when the run carries no seedId", async () => {
		const rec = recordingTracker({ "warren-8cbf": "legacy issue" });
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "Work seeds issue warren-8cbf from the queue.",
			seedId: null,
			issueTracker: rec.tracker,
		});
		expect(ctx.seed).toEqual({ id: "warren-8cbf", title: "legacy issue" });
		expect(rec.shown).toEqual(["warren-8cbf"]);
	});

	test("declines an ambiguous prompt naming several distinct seed ids", async () => {
		const rec = recordingTracker({ "warren-8cbf": "first", "warren-e14e": "second" });
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "Fix warren-8cbf, which duplicates warren-e14e.",
			issueTracker: rec.tracker,
		});
		expect(ctx.seed).toBeNull();
		expect(rec.shown).toEqual([]);
	});

	test("accepts a repeated single seed id in the prompt", async () => {
		const rec = recordingTracker({ "warren-8cbf": "repeated" });
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "warren-8cbf: do the thing. Close warren-8cbf when done.",
			issueTracker: rec.tracker,
		});
		expect(ctx.seed).toEqual({ id: "warren-8cbf", title: "repeated" });
		expect(rec.shown).toEqual(["warren-8cbf"]);
	});

	test("returns null when the seedId lookup fails", async () => {
		const rec = recordingTracker();
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "no seed here",
			seedId: "warren-dead",
			issueTracker: rec.tracker,
		});
		expect(ctx.seed).toBeNull();
		expect(rec.shown).toEqual(["warren-dead"]);
	});

	test("degrades to null when no tracker is configured (warren-47b0)", async () => {
		const ctx = await gatherPrContext({
			...BASE,
			prompt: "Work seeds issue warren-8cbf.",
			seedId: "warren-8cbf",
		});
		expect(ctx.seed).toBeNull();
	});
});

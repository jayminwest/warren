import { describe, expect, test } from "bun:test";
import { NOOP_BRIDGE_LOGGER } from "../stream/index.ts";
import {
	type DiffStats,
	parseNumstat,
	type RecordOutcomeFactsInput,
	recordOutcomeFacts,
} from "./outcome-facts.ts";
import type { ReapExec } from "./types.ts";

/** A 40-hex SHA served as the merge-base stdout when the stub carries one. */
const MERGE_BASE_SHA = "a".repeat(40);

/**
 * Exec stub routing `git diff --numstat` to a canned stdout (or a throw);
 * `git merge-base` returns `mergeBase` (a 40-hex SHA or a throw), everything
 * else the numstat payload. `null` mergeBase degrades the SHA measurement.
 */
function stubExec(
	numstat: string | Error,
	mergeBase: string | null = null,
): {
	exec: ReapExec;
	calls: { cmd: string; args: readonly string[]; cwd: string }[];
} {
	const calls: { cmd: string; args: readonly string[]; cwd: string }[] = [];
	return {
		calls,
		exec: {
			run: async (cmd, args, opt) => {
				calls.push({ cmd, args, cwd: opt.cwd });
				if (args[0] === "merge-base") {
					if (mergeBase === null) throw new Error("merge-base failed");
					return { stdout: mergeBase, stderr: "" };
				}
				if (numstat instanceof Error) throw numstat;
				return { stdout: numstat, stderr: "" };
			},
		},
	};
}

function inputFor(
	overrides: Partial<RecordOutcomeFactsInput>,
	exec: ReapExec,
	captured: { facts: Record<string, unknown> | null },
): RecordOutcomeFactsInput {
	return {
		runId: "run-1",
		workspacePath: "/data/sandbox/ws",
		branch: "agent/bot/run-1",
		baseBranch: "main",
		project: { gitUrl: "https://github.com/x/y.git", localPath: "/data/projects/x/y" },
		commitsAhead: 1,
		branchPushed: true,
		exec,
		log: NOOP_BRIDGE_LOGGER,
		setOutcomeFacts: async (_id, facts) => {
			captured.facts = facts;
		},
		...overrides,
	};
}

describe("parseNumstat (warren-ab2b)", () => {
	test("sums added/deleted across rows and counts files", () => {
		expect(parseNumstat("3\t1\tsrc/a.ts\n2\t4\tsrc/b.ts\n")).toEqual({
			filesChanged: 2,
			insertions: 5,
			deletions: 5,
		});
	});

	test("binary rows count as a file with zero line deltas", () => {
		expect(parseNumstat("-\t-\tbin/x.png\n1\t0\tREADME.md\n")).toEqual({
			filesChanged: 2,
			insertions: 1,
			deletions: 0,
		});
	});

	test("empty output is a zeroed measurement", () => {
		expect(parseNumstat("")).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
	});
});

describe("recordOutcomeFacts (warren-ab2b)", () => {
	test("commitsAhead null means the whole measurement stays unknown (all NULL)", async () => {
		const { exec, calls } = stubExec("1\t1\ta.ts\n");
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const stats = await recordOutcomeFacts(inputFor({ commitsAhead: null }, exec, captured));
		expect(stats).toBeNull();
		expect(calls).toHaveLength(0);
		expect(captured.facts).toEqual({
			commitsAhead: null,
			baseSha: null,
			filesChanged: null,
			insertions: null,
			deletions: null,
		});
	});

	test("commitsAhead 0 is a known empty diff — zeros without a git read", async () => {
		const { exec, calls } = stubExec(new Error("must not run"));
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const stats = await recordOutcomeFacts(inputFor({ commitsAhead: 0 }, exec, captured));
		expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
		expect(calls).toHaveLength(0);
		expect(captured.facts).toEqual({
			commitsAhead: 0,
			baseSha: null,
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
		});
	});

	test("local path diffs base..HEAD on the workspace and stamps the parsed totals", async () => {
		const { exec, calls } = stubExec("5\t2\tsrc/a.ts\n");
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const stats = await recordOutcomeFacts(inputFor({}, exec, captured));
		expect(stats).toEqual({ filesChanged: 1, insertions: 5, deletions: 2 });
		// numstat + merge-base (parallel) — the SHA measurement rides the diff read.
		expect(calls).toHaveLength(2);
		expect(calls[0]?.args).toEqual(["diff", "--numstat", "main..HEAD"]);
		expect(calls[0]?.cwd).toBe("/data/sandbox/ws");
		expect(captured.facts).toEqual({
			commitsAhead: 1,
			baseSha: null,
			filesChanged: 1,
			insertions: 5,
			deletions: 2,
		});
	});

	test("a failed numstat degrades the diff to unknown but keeps commitsAhead", async () => {
		const { exec } = stubExec(new Error("git exploded"));
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const stats = await recordOutcomeFacts(inputFor({}, exec, captured));
		expect(stats).toBeNull();
		expect(captured.facts).toEqual({
			commitsAhead: 1,
			baseSha: null,
			filesChanged: null,
			insertions: null,
			deletions: null,
		});
	});

	test("the local path resolves base_sha off the workspace merge-base (warren-b19e)", async () => {
		const { exec, calls } = stubExec("5\t2\tsrc/a.ts\n", MERGE_BASE_SHA);
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		await recordOutcomeFacts(inputFor({}, exec, captured));
		expect(captured.facts).toMatchObject({ baseSha: MERGE_BASE_SHA });
		// merge-base(baseBranch, HEAD) = the commit the workspace was cut at,
		// covering the unpinned dispatch case base_commit misses.
		expect(
			calls.some((c) => c.args[0] === "merge-base" && c.args[1] === "main" && c.args[2] === "HEAD"),
		).toBe(true);
	});

	test("K8s without a forge credential leaves the diff unknown", async () => {
		const { exec, calls } = stubExec("1\t1\ta.ts\n");
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const stats = await recordOutcomeFacts(
			inputFor({ workspacePath: null, forge: undefined }, exec, captured),
		);
		expect(stats).toBeNull();
		expect(calls).toHaveLength(0);
		expect(captured.facts).toEqual({
			commitsAhead: 1,
			baseSha: null,
			filesChanged: null,
			insertions: null,
			deletions: null,
		});
	});

	test("K8s path fetches the pushed branch into the clone and diffs the temp ref", async () => {
		const { exec, calls } = stubExec("7\t3\tsrc/c.ts\n");
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const forge = {
			parseRepoRef: (url: string) =>
				url.includes("github.com") ? { forge: "github" as const, owner: "x", repo: "y" } : null,
			gitCredential: async () => ({
				ok: true as const,
				value: { username: "x-access-token", secret: "tok", expiresAt: null },
			}),
		};
		const stats = await recordOutcomeFacts(
			inputFor({ workspacePath: null, forge: forge as never }, exec, captured),
		);
		expect(stats).toEqual({ filesChanged: 1, insertions: 7, deletions: 3 });
		// fetch → numstat + merge-base (parallel) → temp-ref cleanup.
		expect(calls).toHaveLength(4);
		expect(calls[0]?.args[0]).toBe("fetch");
		expect(calls[0]?.args[3]).toBe("https://x-access-token:tok@github.com/x/y.git");
		expect(calls[0]?.args[4]).toBe("agent/bot/run-1:refs/warren/outcome-facts/run-1");
		expect(calls[0]?.cwd).toBe("/data/projects/x/y");
		expect(calls[1]?.args).toEqual(["diff", "--numstat", "main..refs/warren/outcome-facts/run-1"]);
		expect(calls[2]?.args).toEqual(["merge-base", "main", "refs/warren/outcome-facts/run-1"]);
		expect(calls[3]?.args).toEqual(["update-ref", "-d", "refs/warren/outcome-facts/run-1"]);
		expect(captured.facts).toEqual({
			commitsAhead: 1,
			baseSha: null,
			filesChanged: 1,
			insertions: 7,
			deletions: 3,
		});
	});

	test("a row-write failure is swallowed (best-effort bookkeeping)", async () => {
		const { exec } = stubExec("1\t1\ta.ts\n");
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const input = inputFor({}, exec, captured);
		const stats = await recordOutcomeFacts({
			...input,
			setOutcomeFacts: async () => {
				throw new Error("db down");
			},
		});
		expect(stats).toEqual({ filesChanged: 1, insertions: 1, deletions: 1 } satisfies DiffStats);
	});
});

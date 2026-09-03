import { describe, expect, test } from "bun:test";
import { NOOP_BRIDGE_LOGGER } from "../stream/index.ts";
import {
	type DiffStats,
	parseNumstat,
	type RecordOutcomeFactsInput,
	recordOutcomeFacts,
} from "./outcome-facts.ts";
import type { ReapExec } from "./types.ts";

const HEAD_SHA = "a".repeat(40);

/**
 * Exec stub: `git rev-parse` answers a fixed HEAD SHA, `git diff --numstat`
 * the canned stdout (or a throw). Everything else passes through empty.
 */
function stubExec(numstat: string | Error): {
	exec: ReapExec;
	calls: { cmd: string; args: readonly string[]; cwd: string }[];
} {
	const calls: { cmd: string; args: readonly string[]; cwd: string }[] = [];
	return {
		calls,
		exec: {
			run: async (cmd, args, opt) => {
				calls.push({ cmd, args, cwd: opt.cwd });
				if (args[0] === "rev-parse") return { stdout: HEAD_SHA, stderr: "" };
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
			filesChanged: null,
			insertions: null,
			deletions: null,
			baseSha: null,
		});
	});

	test("commitsAhead 0 is a known empty diff — zeros without a numstat read", async () => {
		const { exec, calls } = stubExec(new Error("must not run"));
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const stats = await recordOutcomeFacts(inputFor({ commitsAhead: 0 }, exec, captured));
		expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual(["rev-parse", "HEAD"]);
		expect(captured.facts).toEqual({
			commitsAhead: 0,
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			baseSha: HEAD_SHA,
		});
	});

	test("local path diffs base..HEAD on the workspace and stamps the parsed totals", async () => {
		const { exec, calls } = stubExec("5\t2\tsrc/a.ts\n");
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const stats = await recordOutcomeFacts(inputFor({}, exec, captured));
		expect(stats).toEqual({ filesChanged: 1, insertions: 5, deletions: 2 });
		expect(calls).toHaveLength(2);
		expect(calls[0]?.args).toEqual(["rev-parse", "HEAD"]);
		expect(calls[0]?.cwd).toBe("/data/sandbox/ws");
		expect(calls[1]?.args).toEqual(["diff", "--numstat", "main..HEAD"]);
		expect(calls[0]?.cwd).toBe("/data/sandbox/ws");
		expect(captured.facts).toEqual({
			commitsAhead: 1,
			filesChanged: 1,
			insertions: 5,
			deletions: 2,
			baseSha: HEAD_SHA,
		});
	});

	test("a failed numstat degrades the diff to unknown but keeps commitsAhead", async () => {
		const { exec } = stubExec(new Error("git exploded"));
		const captured: { facts: Record<string, unknown> | null } = { facts: null };
		const stats = await recordOutcomeFacts(inputFor({}, exec, captured));
		expect(stats).toBeNull();
		expect(captured.facts).toEqual({
			commitsAhead: 1,
			filesChanged: null,
			insertions: null,
			deletions: null,
			baseSha: HEAD_SHA,
		});
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
			filesChanged: null,
			insertions: null,
			deletions: null,
			baseSha: null,
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
		// fetch → rev-parse tempRef (baseSha) → numstat → temp-ref cleanup.
		expect(calls).toHaveLength(4);
		expect(calls[0]?.args[0]).toBe("fetch");
		expect(calls[0]?.args[3]).toBe("https://x-access-token:tok@github.com/x/y.git");
		expect(calls[0]?.args[4]).toBe("agent/bot/run-1:refs/warren/outcome-facts/run-1");
		expect(calls[0]?.cwd).toBe("/data/projects/x/y");
		expect(calls[1]?.args).toEqual(["rev-parse", "refs/warren/outcome-facts/run-1"]);
		expect(calls[2]?.args).toEqual(["diff", "--numstat", "main..refs/warren/outcome-facts/run-1"]);
		expect(calls[3]?.args).toEqual(["update-ref", "-d", "refs/warren/outcome-facts/run-1"]);
		expect(captured.facts).toEqual({
			commitsAhead: 1,
			filesChanged: 1,
			insertions: 7,
			deletions: 3,
			baseSha: HEAD_SHA,
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

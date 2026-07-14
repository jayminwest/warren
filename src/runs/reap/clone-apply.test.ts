import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FinalizeResult } from "../../runtime/contract.ts";
import { applyCloneDeltas } from "./clone-apply.ts";
import { createPipelineState, type ReapPipelineContext } from "./pipeline.ts";
import type { ReapStep } from "./types.ts";
import { defaultExec, defaultFs } from "./util.ts";

/**
 * Leg 2 (warren-e9e1) verified against a REAL temp git clone: the K8s finalize's
 * mirror deltas (mulch/seeds merged bodies) must land in the project clone and be
 * committed by the canonical warren bot identity (`warren <warren@os-eco.dev>`),
 * never re-spelled inline (CLAUDE.md Article VII).
 */

async function git(cwd: string, ...args: string[]): Promise<string> {
	const out = await defaultExec.run("git", args, { cwd, timeoutMs: 10_000 });
	return out.stdout;
}

/** Minimal pipeline context — applyCloneDeltas only touches these fields. */
function makeCtx(
	clonePath: string,
	emitted: { kind: string; payload: unknown }[],
	failed: { step: ReapStep; message: string }[],
): ReapPipelineContext {
	return {
		project: { localPath: clonePath },
		fs: defaultFs,
		exec: defaultExec,
		emit: async (kind: string, payload: unknown) => {
			emitted.push({ kind, payload });
			return {} as never;
		},
		fail: async (step: ReapStep, err: unknown) => {
			failed.push({ step, message: err instanceof Error ? err.message : String(err) });
		},
	} as unknown as ReapPipelineContext;
}

function resultWithDeltas(): FinalizeResult {
	return {
		pushed: true,
		commitsAhead: 2,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [],
		mirror: {
			mulch: {
				version: 1,
				updated: 1,
				skipped: 0,
				appended: 0,
				files: [
					{
						domain: "build",
						path: ".mulch/expertise/build.jsonl",
						mergedBody: '{"id":"mx-1","recorded_at":"2026-07-01T00:00:00Z","content":"merged"}\n',
					},
				],
			},
			seeds: {
				version: 1,
				closed: 1,
				created: 0,
				path: ".seeds/issues.jsonl",
				mergedBody: '{"id":"warren-1","status":"closed"}\n',
			},
			plans: { version: 1, appended: 0, path: ".seeds/plans.jsonl", mergedBody: null },
		},
		prBranch: "warren/run-1",
		stages: [],
	};
}

/**
 * Git env vars that pin repo discovery to a specific worktree. A git pre-commit
 * hook (this repo runs `check:all` in one) sets `GIT_DIR` / `GIT_INDEX_FILE` in
 * the environment; if inherited, the temp-repo `git commit` below would ignore
 * its `cwd` and write to the REAL repo. Clear them so the temp clone is hermetic.
 */
const GIT_DISCOVERY_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
] as const;

describe("applyCloneDeltas (leg 2, real git clone)", () => {
	let dir: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(async () => {
		savedEnv = {};
		for (const key of GIT_DISCOVERY_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		dir = await mkdtemp(join(tmpdir(), "warren-clone-apply-"));
		await git(dir, "init", "-q");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		for (const key of GIT_DISCOVERY_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("writes merged bodies into the clone and commits as the warren bot", async () => {
		const emitted: { kind: string; payload: unknown }[] = [];
		const failed: { step: ReapStep; message: string }[] = [];
		const state = createPipelineState();

		const committed = await applyCloneDeltas(
			makeCtx(dir, emitted, failed),
			state,
			resultWithDeltas(),
		);

		expect(committed).toBe(true);
		expect(failed).toEqual([]);
		expect(state.cloneDeltasApplied).toBe(true);

		// Merged bodies landed in the clone working tree.
		const mulch = await readFile(join(dir, ".mulch/expertise/build.jsonl"), "utf-8");
		expect(mulch).toContain('"content":"merged"');
		const seeds = await readFile(join(dir, ".seeds/issues.jsonl"), "utf-8");
		expect(seeds).toContain('"status":"closed"');

		// The commit is authored by the canonical warren bot identity.
		const author = (await git(dir, "log", "-1", "--format=%an <%ae>")).trim();
		expect(author).toBe("warren <warren@os-eco.dev>");
		const committer = (await git(dir, "log", "-1", "--format=%cn <%ce>")).trim();
		expect(committer).toBe("warren <warren@os-eco.dev>");
		const subject = (await git(dir, "log", "-1", "--format=%s")).trim();
		expect(subject).toBe("chore(warren): mirror state");

		// Only the delta carriers are in the commit — plans (null body) is absent.
		const files = (await git(dir, "show", "--name-only", "--format=", "HEAD")).trim().split("\n");
		expect(files.sort()).toEqual([".mulch/expertise/build.jsonl", ".seeds/issues.jsonl"]);

		const applied = emitted.find((e) => e.kind === "reap.clone_deltas_applied");
		expect(applied?.payload).toMatchObject({ filesWritten: 2, seeds: true, plans: false });
	});

	test("no-op (no commit) when the mirror carries no merged bodies", async () => {
		const emitted: { kind: string; payload: unknown }[] = [];
		const failed: { step: ReapStep; message: string }[] = [];
		const state = createPipelineState();
		const empty: FinalizeResult = { ...resultWithDeltas(), mirror: {} };

		const committed = await applyCloneDeltas(makeCtx(dir, emitted, failed), state, empty);

		expect(committed).toBe(false);
		expect(state.cloneDeltasApplied).toBe(false);
		expect(emitted).toEqual([]);
		// No commit was authored.
		await expect(git(dir, "rev-parse", "HEAD")).rejects.toThrow();
	});

	test("hermetic: hostile GIT_DIR/GIT_INDEX_FILE can't divert the commit to another repo", async () => {
		// Simulate the pre-commit-hook leak the spawn-site scrub defends against
		// (warren-fa84): a parent `git commit` exports repo-context GIT_* into the
		// environment. Point them at a decoy repo AFTER the beforeEach cleared them
		// — proving hermeticity comes from clone-apply's spawn-site scrub, not from
		// test-level env clearing. Without the scrub the commit lands in the decoy.
		const decoy = await mkdtemp(join(tmpdir(), "warren-clone-apply-decoy-"));
		try {
			await git(decoy, "init", "-q");
			await git(
				decoy,
				"-c",
				"user.name=d",
				"-c",
				"user.email=d@d",
				"commit",
				"--allow-empty",
				"-q",
				"-m",
				"decoy base",
			);
			const decoyHeadBefore = (await git(decoy, "rev-parse", "HEAD")).trim();

			process.env.GIT_DIR = join(decoy, ".git");
			process.env.GIT_INDEX_FILE = join(decoy, ".git", "index");
			process.env.GIT_PREFIX = "";

			const state = createPipelineState();
			const committed = await applyCloneDeltas(makeCtx(dir, [], []), state, resultWithDeltas());

			// Drop the hostile env before assertions so this test's own git() calls
			// (which don't scrub) read each repo through its `cwd` again.
			delete process.env.GIT_DIR;
			delete process.env.GIT_INDEX_FILE;
			delete process.env.GIT_PREFIX;

			expect(committed).toBe(true);
			// The commit landed in the CLONE, authored by the warren bot.
			const cloneSubject = (await git(dir, "log", "-1", "--format=%s")).trim();
			expect(cloneSubject).toBe("chore(warren): mirror state");
			// The decoy repo is untouched — no diverted commit.
			const decoyHeadAfter = (await git(decoy, "rev-parse", "HEAD")).trim();
			expect(decoyHeadAfter).toBe(decoyHeadBefore);
		} finally {
			await rm(decoy, { recursive: true, force: true });
		}
	});

	test("idempotent: a second apply of identical bodies commits nothing", async () => {
		const emitted: { kind: string; payload: unknown }[] = [];
		const failed: { step: ReapStep; message: string }[] = [];
		const state = createPipelineState();

		await applyCloneDeltas(makeCtx(dir, emitted, failed), state, resultWithDeltas());
		const firstHead = (await git(dir, "rev-parse", "HEAD")).trim();

		const state2 = createPipelineState();
		const committed2 = await applyCloneDeltas(
			makeCtx(dir, emitted, failed),
			state2,
			resultWithDeltas(),
		);

		expect(committed2).toBe(false);
		expect(state2.cloneDeltasApplied).toBe(false);
		const secondHead = (await git(dir, "rev-parse", "HEAD")).trim();
		expect(secondHead).toBe(firstHead);
	});
});

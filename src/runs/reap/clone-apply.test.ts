import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WARREN_BOT_IDENTITY } from "../../bot-identity.ts";
import type { Forge } from "../../forge/contract.ts";
import type { FinalizeResult } from "../../runtime/contract.ts";
import { assertFixtureHermetic, gitFixtureEnv } from "../../workspace/git/test-fixture.ts";
import { applyCloneDeltas, pushCloneDeltasToOrigin } from "./clone-apply.ts";
import { createPipelineState, type ReapPipelineContext } from "./pipeline.ts";
import { fakeForge, stubForge } from "./test-helpers.ts";
import type { ReapStep } from "./types.ts";
import { defaultExec, defaultFs } from "./util.ts";

/**
 * Leg 2 (warren-e9e1) verified against a REAL temp git clone: the K8s finalize's
 * mirror deltas (mulch/seeds merged bodies) must land in the project clone and be
 * committed by the canonical warren bot identity (`WARREN_BOT_IDENTITY`),
 * never re-spelled inline (CLAUDE.md Article VII).
 */

/**
 * Test-side git helper. Every spawn carries the canonical hermetic fixture env
 * (warren-cfa7) — inherited GIT_* severed, discovery ceiling pinned — so the
 * suite never depends on the beforeEach clearing alone: the pre-commit hook's
 * exported GIT_DIR/GIT_INDEX_FILE can't redirect these calls at the real repo.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const out = await defaultExec.run("git", args, {
		cwd,
		timeoutMs: 10_000,
		env: gitFixtureEnv(cwd),
	});
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
		artifacts: {
			mulch: {
				version: 1,
				files: [
					{
						path: ".mulch/expertise/build.jsonl",
						mergedBody: '{"id":"mx-1","recorded_at":"2026-07-01T00:00:00Z","content":"merged"}\n',
					},
				],
				counts: { updated: 1, skipped: 0, appended: 0 },
			},
			seeds: {
				version: 1,
				files: [
					{ path: ".seeds/issues.jsonl", mergedBody: '{"id":"warren-1","status":"closed"}\n' },
				],
				counts: { closed: 1, created: 0 },
			},
			plans: { version: 1, files: [], counts: { appended: 0 } },
		},
		prBranch: "warren/run-1",
		stages: [],
	};
}

/**
 * Git env vars that pin repo discovery to a specific worktree. A git pre-commit
 * hook (this repo runs `check:all` in one) sets `GIT_DIR` / `GIT_INDEX_FILE` in
 * the environment; if inherited, the temp-repo `git commit` below would ignore
 * its `cwd` and write to the REAL repo. Cleared here as defense in depth — the
 * primary hermeticity is the spawn-site fixture env in git() (warren-cfa7).
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
		// warren-cfa7 guard: the fixture resolves its git dir INSIDE itself.
		await assertFixtureHermetic(dir);
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
		expect(author).toBe(`${WARREN_BOT_IDENTITY.name} <${WARREN_BOT_IDENTITY.email}>`);
		const committer = (await git(dir, "log", "-1", "--format=%cn <%ce>")).trim();
		expect(committer).toBe(`${WARREN_BOT_IDENTITY.name} <${WARREN_BOT_IDENTITY.email}>`);
		const subject = (await git(dir, "log", "-1", "--format=%s")).trim();
		expect(subject).toBe("chore(warren): mirror state");

		// Only the delta carriers are in the commit — plans (null body) is absent.
		const files = (await git(dir, "show", "--name-only", "--format=", "HEAD")).trim().split("\n");
		expect(files.sort()).toEqual([".mulch/expertise/build.jsonl", ".seeds/issues.jsonl"]);

		const applied = emitted.find((e) => e.kind === "reap.clone_deltas_applied");
		expect(applied?.payload).toMatchObject({ filesWritten: 2, artifacts: { mulch: 1, seeds: 1 } });
	});

	test("no-op (no commit) when the mirror carries no merged bodies", async () => {
		const emitted: { kind: string; payload: unknown }[] = [];
		const failed: { step: ReapStep; message: string }[] = [];
		const state = createPipelineState();
		const empty: FinalizeResult = { ...resultWithDeltas(), artifacts: {} };

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

			// Drop the hostile env before assertions (the suite shares one process;
			// leaving it set would poison later files even though git() now scrubs).
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

describe("pushCloneDeltasToOrigin (warren-486c durability + warren-4e1c credential)", () => {
	/** Recording exec — the push never touches a real remote. */
	function recordingExec(opts: { failPush?: boolean } = {}) {
		const calls: { args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
		const exec: ReapPipelineContext["exec"] = {
			run: async (_cmd, args, o) => {
				calls.push({ args, ...(o.env !== undefined ? { env: o.env } : {}) });
				if (opts.failPush === true && args[0] === "push") throw new Error("push declined");
				return { stdout: "", stderr: "" };
			},
		};
		return { exec, calls };
	}

	function pushCtx(
		exec: ReapPipelineContext["exec"],
		failed: { step: ReapStep; message: string }[],
		forge?: Forge,
	): ReapPipelineContext {
		return {
			input: { ...(forge !== undefined ? { forge } : {}) },
			project: {
				localPath: "/data/projects/x/y",
				gitUrl: "https://github.com/x/y.git",
			},
			exec,
			emit: async () => ({}) as never,
			fail: async (step: ReapStep, err: unknown) => {
				failed.push({ step, message: err instanceof Error ? err.message : String(err) });
			},
		} as unknown as ReapPipelineContext;
	}

	test("the mirror push carries a credential minted from the forge as GIT_CONFIG_* env", async () => {
		const { exec, calls } = recordingExec();
		const failed: { step: ReapStep; message: string }[] = [];
		const ok = await pushCloneDeltasToOrigin(pushCtx(exec, failed, fakeForge()), "main");
		expect(ok).toBe(true);
		expect(failed).toEqual([]);
		const push = calls.find((c) => c.args[0] === "push");
		expect(push?.args).toEqual(["push", "origin", "HEAD:main"]);
		// Minted from the forge (FakeForge's static secret), per-spawn — never held.
		expect(push?.env?.GIT_CONFIG_COUNT).toBe("1");
		expect(push?.env?.GIT_CONFIG_KEY_0).toBe(
			"url.https://fake:fake-credential@github.com/.insteadOf",
		);
		expect(push?.env?.GIT_CONFIG_VALUE_0).toBe("https://github.com/");
		// The repo-context scrub still rides alongside the credential.
		expect(push?.env?.GIT_DIR).toBeUndefined();
		expect(push?.env && "GIT_DIR" in push.env).toBe(true);
	});

	test("no forge on the reap input keeps the mirror push anonymous", async () => {
		const { exec, calls } = recordingExec();
		const failed: { step: ReapStep; message: string }[] = [];
		const ok = await pushCloneDeltasToOrigin(pushCtx(exec, failed), "main");
		expect(ok).toBe(true);
		const push = calls.find((c) => c.args[0] === "push");
		expect(push?.env && "GIT_CONFIG_COUNT" in push.env).toBe(false);
	});

	test("a 40-hex ref is skipped with a logged reason, never pushed (warren-aaf7)", async () => {
		const { exec, calls } = recordingExec();
		const failed: { step: ReapStep; message: string }[] = [];
		const emitted: { kind: string; payload: unknown }[] = [];
		const ctx = {
			...pushCtx(exec, failed),
			emit: async (kind: string, payload: unknown) => {
				emitted.push({ kind, payload });
				return {} as never;
			},
		} as unknown as ReapPipelineContext;
		const sha = "0123456789abcdef0123456789abcdef01234567";
		const ok = await pushCloneDeltasToOrigin(ctx, sha);
		expect(ok).toBe(false);
		expect(calls.find((c) => c.args[0] === "push")).toBeUndefined();
		expect(failed).toEqual([]);
		expect(emitted).toEqual([
			{ kind: "reap.clone_deltas_push_skipped", payload: { ref: sha, reason: expect.any(String) } },
		]);
	});

	test("a mint failure folds into clone_apply_push and suppresses the push", async () => {
		const { exec, calls } = recordingExec();
		const failed: { step: ReapStep; message: string }[] = [];
		const forge = stubForge({
			gitCredential: () =>
				Promise.resolve({ ok: false, error: { kind: "unauthorized", detail: "key revoked" } }),
		});
		const ok = await pushCloneDeltasToOrigin(pushCtx(exec, failed, forge), "main");
		expect(ok).toBe(false);
		expect(calls.find((c) => c.args[0] === "push")).toBeUndefined();
		expect(failed.map((f) => f.step)).toEqual(["clone_apply_push"]);
		expect(failed[0]?.message).toContain("key revoked");
	});
});

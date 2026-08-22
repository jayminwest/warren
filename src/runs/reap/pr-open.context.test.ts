import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertFixtureHermetic,
	fixtureGitOrThrow,
	gitFixtureEnv,
} from "../../workspace/git/test-fixture.ts";
import { gatherPrContext } from "./pr-context.ts";
import type { ReapExec } from "./types.ts";

/**
 * warren-ab66: the K8s pr-open path has no host worktree, so `gatherPrContext`
 * fetches the pushed run branch into the project clone and rebuilds the
 * commit-list + diff-stat sections there. These tests exercise it against real
 * temp git repos (an "origin" the clone fetches from), the fetch-failure
 * fallback, and the unchanged LocalProvider (`workspacePath`) path.
 */

/**
 * A real `ReapExec` over `Bun.spawn` — rejects on non-zero exit like
 * production. Every spawn runs with the canonical hermetic fixture env
 * (warren-cfa7): inherited GIT_* severed, discovery ceiling pinned to the
 * cwd's parent — so the pre-commit hook's exported GIT_DIR/GIT_INDEX_FILE can
 * never redirect these calls at the invoking repo.
 */
const realExec: ReapExec = {
	run: async (cmd, args, opts) => {
		const proc = Bun.spawn([cmd, ...args], {
			cwd: opts.cwd,
			env: gitFixtureEnv(opts.cwd),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) {
			throw new Error(`${cmd} ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	},
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await fixtureGitOrThrow(cwd, args)).stdout;
}

async function commitFile(cwd: string, file: string, body: string, message: string): Promise<void> {
	await Bun.write(join(cwd, file), body);
	await git(cwd, "add", "--", file);
	await git(cwd, "-c", "user.email=t@t.dev", "-c", "user.name=Tester", "commit", "-m", message);
}

describe("gatherPrContext K8s clone fetch (warren-ab66)", () => {
	let root: string;
	let origin: string;
	let clone: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "warren-pr-ctx-"));
		origin = join(root, "origin");
		clone = join(root, "clone");
		// Origin: main with a base commit, then run branch with two real commits.
		await git(root, "init", "-q", "-b", "main", origin);
		await commitFile(origin, "README.md", "base\n", "base commit");
		await git(origin, "checkout", "-q", "-b", "run-1");
		await commitFile(origin, "a.ts", "export const a = 1;\n", "feat: add a");
		await commitFile(origin, "b.ts", "export const b = 2;\n", "feat: add b");
		await git(origin, "checkout", "-q", "main");
		// Project clone: a host-side clone the control plane maintains (main checked out).
		await git(root, "clone", "-q", origin, clone);
		// warren-cfa7 guard: both fixture repos resolve their git dir INSIDE the
		// fixture — never to the invoking repo.
		await assertFixtureHermetic(origin);
		await assertFixtureHermetic(clone);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("rebuilds commits + diff-stat from the pushed branch and cleans up the temp ref", async () => {
		const ctx = await gatherPrContext({
			workspacePath: null,
			projectPath: clone,
			baseBranch: "main",
			prompt: "no seed here",
			exec: realExec,
			cloneFetch: {
				runBranch: "run-1",
				runId: "run-abc",
				gitUrl: origin,
				gitCredential: { username: "x-access-token", secret: "", host: "github.com" },
			},
		});
		expect(ctx.commits.map((c) => c.subject)).toEqual(["feat: add a", "feat: add b"]);
		for (const c of ctx.commits) expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(ctx.diffStat).toContain("a.ts");
		expect(ctx.diffStat).toContain("b.ts");
		// The temp fetch ref is deleted after the reads.
		const refs = await git(clone, "for-each-ref", "--format=%(refname)", "refs/warren/");
		expect(refs.trim()).toBe("");
	});

	test("fetch failure degrades to empty sections, emits a warning, and never throws", async () => {
		const emitted: { kind: string; payload: unknown }[] = [];
		const ctx = await gatherPrContext({
			workspacePath: null,
			projectPath: clone,
			baseBranch: "main",
			prompt: "no seed here",
			exec: realExec,
			cloneFetch: {
				runBranch: "run-1",
				runId: "run-def",
				gitUrl: join(root, "does-not-exist"),
				gitCredential: { username: "x-access-token", secret: "", host: "github.com" },
			},
			emit: async (kind, payload) => {
				emitted.push({ kind, payload });
			},
		});
		expect(ctx.commits).toEqual([]);
		expect(ctx.diffStat).toBe("");
		const degraded = emitted.find((e) => e.kind === "reap.pr_open_context_degraded");
		expect(degraded).toBeDefined();
		expect(degraded?.payload).toMatchObject({ reason: "clone_fetch_failed", branch: "run-1" });
	});

	test("no cloneFetch under K8s keeps the pre-warren-ab66 empty-section behavior", async () => {
		const ctx = await gatherPrContext({
			workspacePath: null,
			projectPath: clone,
			baseBranch: "main",
			prompt: "no seed here",
			exec: realExec,
		});
		expect(ctx.commits).toEqual([]);
		expect(ctx.diffStat).toBe("");
	});

	test("LocalProvider path reads base..HEAD from the host worktree, ignoring cloneFetch", async () => {
		// A host worktree checked out at run-1 (the LocalProvider shape).
		await git(clone, "fetch", "-q", "origin", "run-1:run-1");
		const worktree = join(root, "ws");
		await git(clone, "worktree", "add", "-q", worktree, "run-1");
		const ctx = await gatherPrContext({
			workspacePath: worktree,
			projectPath: clone,
			baseBranch: "main",
			prompt: "no seed here",
			exec: realExec,
			// Present but must be ignored because workspacePath !== null.
			cloneFetch: {
				runBranch: "run-1",
				runId: "run-ghi",
				gitUrl: origin,
				gitCredential: { username: "x-access-token", secret: "", host: "github.com" },
			},
		});
		expect(ctx.commits.map((c) => c.subject)).toEqual(["feat: add a", "feat: add b"]);
		expect(ctx.diffStat).toContain("a.ts");
		// cloneFetch was not used, so no temp ref was created in the clone.
		const refs = await git(clone, "for-each-ref", "--format=%(refname)", "refs/warren/");
		expect(refs.trim()).toBe("");
	});

	test("lifts the final commit body (not the subject) for the Agent notes section (warren-5e86)", async () => {
		// Reword the tip of run-1 with a multi-paragraph body.
		await git(origin, "checkout", "-q", "run-1");
		await git(
			origin,
			"-c",
			"user.email=t@t.dev",
			"-c",
			"user.name=Tester",
			"commit",
			"--amend",
			"-q",
			"-m",
			"feat: add b",
			"-m",
			"Rationale: the seam was already there.\n\nHandoff: watch the retry path.",
		);
		await git(origin, "checkout", "-q", "main");
		const ctx = await gatherPrContext({
			workspacePath: null,
			projectPath: clone,
			baseBranch: "main",
			prompt: "no seed here",
			exec: realExec,
			cloneFetch: {
				runBranch: "run-1",
				runId: "run-body",
				gitUrl: origin,
				gitCredential: { username: "x-access-token", secret: "", host: "github.com" },
			},
		});
		expect(ctx.finalCommitBody).toBe(
			"Rationale: the seam was already there.\n\nHandoff: watch the retry path.",
		);
		expect(ctx.finalCommitBody).not.toContain("feat: add b");
	});

	test("a subject-only final commit yields a null body (section omitted)", async () => {
		const ctx = await gatherPrContext({
			workspacePath: null,
			projectPath: clone,
			baseBranch: "main",
			prompt: "no seed here",
			exec: realExec,
			cloneFetch: {
				runBranch: "run-1",
				runId: "run-nobody",
				gitUrl: origin,
				gitCredential: { username: "x-access-token", secret: "", host: "github.com" },
			},
		});
		expect(ctx.finalCommitBody).toBeNull();
	});
});

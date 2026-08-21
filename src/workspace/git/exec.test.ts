import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceMaterializationError } from "../errors.ts";
import { runGit, runGitOrThrow } from "./exec.ts";
import { mkdtempOutsideRepo, scrubbedGitEnv } from "./test-fixture.ts";

export function cleanGitEnv(
	extra: Record<string, string | undefined> = {},
): Record<string, string> {
	const out = scrubbedGitEnv();
	for (const [k, v] of Object.entries(extra)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

describe("runGit", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempOutsideRepo("warren-exec-");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("returns exitCode 0 and stdout for a successful command", async () => {
		const res = await runGit(["--version"]);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toMatch(/git version/);
		expect(res.stderr).toBe("");
	});

	test("runs in the provided cwd", async () => {
		await runGit(["init", "-q"], { cwd: root, env: cleanGitEnv() });
		const res = await runGit(["rev-parse", "--is-inside-work-tree"], {
			cwd: root,
			env: cleanGitEnv(),
		});
		expect(res.exitCode).toBe(0);
		expect(res.stdout.trim()).toBe("true");
	});

	test("returns a non-zero exitCode with stderr instead of throwing", async () => {
		const res = await runGit(["rev-parse", "--is-inside-work-tree"], {
			cwd: root,
			env: cleanGitEnv(),
		});
		expect(res.exitCode).not.toBe(0);
		expect(res.stderr).toMatch(/not a git repository/i);
	});

	test("passes a filtered env through to the subprocess", async () => {
		await runGit(["init", "-q"], { cwd: root, env: cleanGitEnv() });
		await runGit(["config", "user.email", "test@example.com"], { cwd: root, env: cleanGitEnv() });
		await runGit(["config", "user.name", "Test"], { cwd: root, env: cleanGitEnv() });
		writeFileSync(join(root, "f.txt"), "hi\n");
		await runGit(["add", "."], { cwd: root, env: cleanGitEnv() });
		const res = await runGit(["commit", "-m", "init"], {
			cwd: root,
			env: cleanGitEnv({
				GIT_AUTHOR_DATE: "2005-04-07T22:13:13",
				GIT_COMMITTER_DATE: "2005-04-07T22:13:13",
			}),
		});
		expect(res.exitCode).toBe(0);
		const show = await runGit(["show", "-s", "--format=%ci", "HEAD"], {
			cwd: root,
			env: cleanGitEnv(),
		});
		expect(show.stdout).toMatch(/2005-04-07/);
	});

	test("undefined env values are dropped rather than serialized", async () => {
		const res = await runGit(["--version"], {
			env: cleanGitEnv({ SOME_UNSET_VAR: undefined }),
		});
		expect(res.exitCode).toBe(0);
	});

	test("feeds stdin into the subprocess", async () => {
		await runGit(["init", "-q"], { cwd: root, env: cleanGitEnv() });
		const res = await runGit(["hash-object", "-w", "--stdin"], {
			cwd: root,
			env: cleanGitEnv(),
			stdin: "hello from stdin\n",
		});
		expect(res.exitCode).toBe(0);
		const oid = res.stdout.trim();
		expect(oid).toMatch(/^[0-9a-f]{40}$/);
		const cat = await runGit(["cat-file", "-p", oid], { cwd: root, env: cleanGitEnv() });
		expect(cat.stdout).toBe("hello from stdin\n");
	});

	test("honors a custom gitBin override", async () => {
		const res = await runGit(["--version"], { gitBin: "git" });
		expect(res.exitCode).toBe(0);
	});
});

describe("runGitOrThrow", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempOutsideRepo("warren-exec-throw-");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("returns the result on success", async () => {
		const res = await runGitOrThrow(["init", "-q"], { cwd: root, env: cleanGitEnv() });
		expect(res.exitCode).toBe(0);
		expect(readFileSync(join(root, ".git", "HEAD"), "utf8")).toMatch(/ref:/);
	});

	test("throws WorkspaceMaterializationError on non-zero exit", async () => {
		await expect(
			runGitOrThrow(["rev-parse", "--is-inside-work-tree"], { cwd: root, env: cleanGitEnv() }),
		).rejects.toBeInstanceOf(WorkspaceMaterializationError);
	});

	test("error message embeds the failing args, exit code, and a recovery hint", async () => {
		try {
			await runGitOrThrow(["rev-parse", "--is-inside-work-tree"], {
				cwd: root,
				env: cleanGitEnv(),
			});
			throw new Error("expected runGitOrThrow to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspaceMaterializationError);
			const e = err as WorkspaceMaterializationError;
			expect(e.message).toMatch(/git rev-parse --is-inside-work-tree failed \(exit \d+\)/);
			expect(e.code).toBe("workspace_materialization_failed");
			expect(e.recoveryHint).toMatch(/Run the failing command by hand/);
		}
	});

	test("falls back to stdout in the message when stderr is empty", async () => {
		await runGitOrThrow(["init", "-q"], { cwd: root, env: cleanGitEnv() });
		// `git config <key>` with a missing key exits non-zero and writes nothing
		// to stderr, so the thrown message must surface the (empty) output without
		// crashing.
		await expect(
			runGitOrThrow(["config", "--get", "no.such.key"], { cwd: root, env: cleanGitEnv() }),
		).rejects.toBeInstanceOf(WorkspaceMaterializationError);
	});
});

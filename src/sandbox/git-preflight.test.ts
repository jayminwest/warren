import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	assertSandboxGit,
	probeSandboxGit,
	resetSandboxGitPreflightCache,
	SandboxGitPreflightError,
	sandboxGitPreflightCached,
	WARREN_SANDBOX_GIT_ENV,
} from "./git-preflight.ts";
import { runSandboxed } from "./sandbox.ts";
import type { SandboxProfile, SpawnResult } from "./types.ts";

/** which stub: resolves git plus the platform sandbox wrappers (warren-1219). */
function whichWith(git: string | null): (name: string) => string | null {
	return (name: string): string | null =>
		name === "git" ? git : name === "bwrap" || name === "sandbox-exec" ? `/usr/bin/${name}` : null;
}

function fakeResult(exitCode: number, text: string): SpawnResult {
	const stream = (s: string): ReadableStream<Uint8Array> =>
		new Response(s).body as ReadableStream<Uint8Array>;
	return {
		pid: 123,
		stdout: stream(text),
		stderr: stream(""),
		exited: Promise.resolve(exitCode),
		cancel: () => {},
		closeStdin: async () => {},
		writeStdin: async () => {},
	};
}

/**
 * Stub `runSandboxed` seam: fails (exit 1 + dyld-shaped stderr) when the
 * profile's first toolchain dir is `failDir`, passes otherwise. That dir is
 * how the stub distinguishes "the bad nix git" from the substituted
 * /usr/bin/git.
 */
function stubSpawnSandbox(failDir: string): typeof runSandboxed {
	return async (profile: SandboxProfile): Promise<SpawnResult> => {
		if (profile.toolchainPaths[0] === failDir) {
			return fakeResult(1, "dyld: Library not loaded: /nix/store/.../libgit2.dylib");
		}
		return fakeResult(0, "git version 2.39.5");
	};
}

const BAD_GIT = "/nix/store/abc-git-2.44/bin/git";
const BAD_DIR = dirname(BAD_GIT);

afterEach(() => {
	resetSandboxGitPreflightCache();
	delete process.env[WARREN_SANDBOX_GIT_ENV];
});

describe("probeSandboxGit", () => {
	test("reports ok when the resolved git executes inside the sandbox", async () => {
		const result = await probeSandboxGit({
			which: whichWith(BAD_GIT),
			env: {},
			spawnSandbox: stubSpawnSandbox("__never__"),
		});
		expect(result.ok).toBe(true);
		expect(result.gitPath).toBe(BAD_GIT);
		expect(result.effectiveGit).toBe(BAD_GIT);
		expect(result.substituted).toBe(false);
		expect(result.message).toContain(BAD_GIT);
	});

	test("fails naming the resolved binary and the exec detail, with a recovery hint", async () => {
		const result = await probeSandboxGit({
			which: whichWith(BAD_GIT),
			env: {},
			spawnSandbox: stubSpawnSandbox(BAD_DIR),
		});
		expect(result.ok).toBe(false);
		expect(result.gitPath).toBe(BAD_GIT);
		expect(result.message).toContain(BAD_GIT);
		expect(result.message).toContain("dyld: Library not loaded");
		expect(result.hint).toContain("/usr/bin/git");
	});

	test("assertSandboxGit throws the typed error carrying the binary path", async () => {
		const result = await probeSandboxGit({
			which: whichWith(BAD_GIT),
			env: {},
			spawnSandbox: stubSpawnSandbox(BAD_DIR),
		});
		expect(() => assertSandboxGit(result)).toThrow(SandboxGitPreflightError);
		try {
			assertSandboxGit(result);
		} catch (err) {
			const typed = err as SandboxGitPreflightError;
			expect(typed.code).toBe("sandbox_git_preflight");
			expect(typed.gitPath).toBe(BAD_GIT);
			expect(typed.detail).toContain(BAD_GIT);
			expect(typed.recoveryHint).toContain("sandbox");
		}
	});

	test("fails with a clear message when no git resolves on PATH", async () => {
		const result = await probeSandboxGit({
			which: () => null,
			env: {},
			spawnSandbox: stubSpawnSandbox(BAD_DIR),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("no git binary");
	});

	test("honors a WARREN_SANDBOX_GIT pin over PATH resolution", async () => {
		const seen: string[] = [];
		const spawnSandbox: typeof runSandboxed = async (profile) => {
			seen.push(profile.toolchainPaths[0] ?? "");
			return fakeResult(0, "git version 2.39.5");
		};
		const result = await probeSandboxGit({
			which: whichWith(BAD_GIT),
			env: { [WARREN_SANDBOX_GIT_ENV]: "/usr/bin/git" },
			spawnSandbox,
		});
		expect(result.ok).toBe(true);
		expect(result.gitPath).toBe("/usr/bin/git");
		expect(seen[0]).toBe("/usr/bin");
	});

	test("substitutes /usr/bin/git on darwin when the resolved git fails but the system git passes", async () => {
		const result = await probeSandboxGit({
			which: whichWith(BAD_GIT),
			env: {},
			platform: "darwin",
			exists: (path) => path === "/usr/bin/git",
			spawnSandbox: stubSpawnSandbox(BAD_DIR),
		});
		expect(result.ok).toBe(true);
		expect(result.substituted).toBe(true);
		expect(result.effectiveGit).toBe("/usr/bin/git");
		expect(result.gitPath).toBe(BAD_GIT);
		expect(result.message).toContain(BAD_GIT);
		expect(result.message).toContain("/usr/bin/git");
	});

	test("does not substitute when the system git also fails", async () => {
		const result = await probeSandboxGit({
			which: whichWith(BAD_GIT),
			env: {},
			platform: "darwin",
			exists: (path) => path === "/usr/bin/git",
			// both probes fail: the stub fails on every toolchain dir
			spawnSandbox: async () => fakeResult(1, "dyld: Library not loaded"),
		});
		expect(result.ok).toBe(false);
		expect(result.substituted).toBe(false);
		expect(result.effectiveGit).toBe(BAD_GIT);
	});

	test("does not substitute on linux even when the resolved git fails", async () => {
		const result = await probeSandboxGit({
			which: whichWith(BAD_GIT),
			env: {},
			platform: "linux",
			exists: (path) => path === "/usr/bin/git",
			spawnSandbox: stubSpawnSandbox(BAD_DIR),
		});
		expect(result.ok).toBe(false);
		expect(result.substituted).toBe(false);
	});

	test("skips with ok when the platform sandbox wrapper is missing", async () => {
		const result = await probeSandboxGit({
			which: (name) => (name === "git" ? "/usr/bin/git" : null),
			env: {},
			spawnSandbox: async () => {
				throw new Error("must not spawn when the wrapper is missing");
			},
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no bwrap sandbox wrapper");
	});

	test("preflight is cached per boot and reset drops the cache", async () => {
		let calls = 0;
		const spawnSandbox: typeof runSandboxed = async () => {
			calls += 1;
			return fakeResult(0, "git version 2.39.5");
		};
		// seed the cache through the cached wrapper
		const first = sandboxGitPreflightCached({
			which: whichWith("/usr/bin/git"),
			env: {},
			spawnSandbox,
		});
		const second = sandboxGitPreflightCached();
		expect(second).toBe(first);
		expect(calls).toBe(1);
		resetSandboxGitPreflightCache();
		const third = sandboxGitPreflightCached();
		expect(third).not.toBe(first);
	});
});

describe("probeSandboxGit (real sandbox, linux + bwrap)", () => {
	function hasBwrap(): boolean {
		return process.platform === "linux" && Bun.which("bwrap") !== null;
	}

	test.skipIf(!hasBwrap())(
		"proves a real host git executes inside bwrap",
		async () => {
			const result = await probeSandboxGit({ env: {} });
			expect(result.ok).toBe(true);
			expect(result.message).toContain("git --version");
		},
		30_000,
	);

	test.skipIf(!hasBwrap())(
		"catches a git stub that fails exec, naming the binary",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "warren-git-preflight-real-"));
			const binDir = join(dir, "bin");
			writeFileSync(join(binDir, "git"), "#!/nonexistent-interpreter-warren-1219\n", {
				mode: 0o755,
			});
			try {
				const badGit = join(binDir, "git");
				const result = await probeSandboxGit({
					which: (name) => (name === "git" ? badGit : null),
					env: {},
					spawnSandbox: runSandboxed,
				});
				expect(result.ok).toBe(false);
				expect(result.message).toContain(badGit);
				expect(() => assertSandboxGit(result)).toThrow(SandboxGitPreflightError);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

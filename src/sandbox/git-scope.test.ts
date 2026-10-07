import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	adminDirOf,
	FIXTURE_GIT_ENV,
	fixtureGitCmd,
	makeWorktreeFixture,
	type WorktreeFixture,
} from "./git-scope.test-helpers.ts";
import { resolveWorkspaceGitScope, WorkspaceGitScopeError } from "./git-scope.ts";
import { runSandboxed } from "./sandbox.ts";
import type { SandboxProfile } from "./types.ts";

describe("resolveWorkspaceGitScope", () => {
	let fx: WorktreeFixture;
	beforeEach(() => {
		fx = makeWorktreeFixture();
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("grants the run's own admin dir plus objects/refs/logs, never config or hooks", () => {
		const scope = resolveWorkspaceGitScope(fx.ws, fx.common);
		const admin = adminDirOf(fx.ws);
		expect(scope.commonDir).toBe(fx.common);
		expect(scope.gitDir).toBe(admin);
		expect(scope.writable).toEqual([
			admin,
			join(fx.common, "objects"),
			join(fx.common, "refs"),
			join(fx.common, "logs"),
		]);
		expect(scope.writable).not.toContain(adminDirOf(fx.sibling));
		expect(scope.writable).not.toContain(fx.common);
		expect(scope.protectedPaths).toEqual([
			join(admin, "commondir"),
			join(admin, "gitdir"),
			join(admin, "config.worktree"),
			join(fx.common, "objects", "info"),
		]);
		expect(existsSync(join(admin, "config.worktree"))).toBe(true);
	});

	test("creates logs/ when absent so the read-only parent never blocks reflogs", () => {
		rmSync(join(fx.common, "logs"), { recursive: true, force: true });
		resolveWorkspaceGitScope(fx.ws, fx.common);
		expect(existsSync(join(fx.common, "logs"))).toBe(true);
	});

	test("rejects a .git symlink in the workspace", () => {
		rmSync(join(fx.ws, ".git"));
		symlinkSync(join(fx.sibling, ".git"), join(fx.ws, ".git"));
		expect(() => resolveWorkspaceGitScope(fx.ws, fx.common)).toThrow(WorkspaceGitScopeError);
	});

	test("rejects a gitdir pointer outside <common>/worktrees", () => {
		const elsewhere = join(fx.root, "elsewhere");
		mkdirSync(elsewhere);
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${elsewhere}\n`);
		expect(() => resolveWorkspaceGitScope(fx.ws, fx.common)).toThrow(/not a direct child/);
	});

	test("rejects a gitdir pointer at a sibling run's admin dir", () => {
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${adminDirOf(fx.sibling)}\n`);
		expect(() => resolveWorkspaceGitScope(fx.ws, fx.common)).toThrow(/belongs to/);
	});

	test("rejects a symlinked admin-dir entry aliasing a sibling", () => {
		const alias = join(fx.common, "worktrees", "alias");
		symlinkSync(adminDirOf(fx.sibling), alias);
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${alias}\n`);
		expect(() => resolveWorkspaceGitScope(fx.ws, fx.common)).toThrow(/belongs to/);
	});

	test("rejects an admin dir whose commondir names another repository", () => {
		const other = join(fx.root, "other");
		mkdirSync(other);
		fixtureGitCmd(other, "init", "-q");
		writeFileSync(join(adminDirOf(fx.ws), "commondir"), `${join(other, ".git")}\n`);
		expect(() => resolveWorkspaceGitScope(fx.ws, fx.common)).toThrow(/different common dir/);
	});

	test("rejects a symlinked admin-dir binding file", () => {
		const admin = adminDirOf(fx.ws);
		const copy = join(fx.root, "commondir-copy");
		writeFileSync(copy, readFileSync(join(admin, "commondir")));
		rmSync(join(admin, "commondir"));
		symlinkSync(copy, join(admin, "commondir"));
		expect(() => resolveWorkspaceGitScope(fx.ws, fx.common)).toThrow(/regular file/);
	});

	test("rejects a symlinked shared store", () => {
		const outside = join(fx.root, "outside-logs");
		mkdirSync(outside);
		rmSync(join(fx.common, "logs"), { recursive: true, force: true });
		symlinkSync(outside, join(fx.common, "logs"));
		expect(() => resolveWorkspaceGitScope(fx.ws, fx.common)).toThrow(/not a symlink/);
	});

	test("rejects a missing common dir", () => {
		expect(() => resolveWorkspaceGitScope(fx.ws, join(fx.root, "nope"))).toThrow(
			WorkspaceGitScopeError,
		);
	});
});

// Real platform sandbox: the run can commit on its branch but cannot rewrite
// clone config, hooks, its admin binding files, or a sibling's index.
// Linux bwrap runs these only where bwrap is installed.
const isDarwin = process.platform === "darwin";
const canSandbox = isDarwin || (process.platform === "linux" && Bun.which("bwrap") !== null);

describe("worktree git scope inside the real sandbox (warren-8926)", () => {
	let fx: WorktreeFixture;
	let home: string;
	beforeEach(() => {
		fx = makeWorktreeFixture();
		home = join(fx.root, "home");
		mkdirSync(home);
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	async function sh(script: string): Promise<{ exit: number; err: string }> {
		const scope = resolveWorkspaceGitScope(fx.ws, fx.common);
		// macOS: /usr/bin/git, the binary the sandbox git preflight falls back
		// to — a nix/homebrew git's dylibs sit outside the profile (warren-1219).
		const gitBinDir = isDarwin
			? "/usr/bin"
			: join(realpathSync(Bun.which("git") ?? "/usr/bin/git"), "..");
		const profile: SandboxProfile = {
			workspace: fx.ws,
			home,
			readOnlyMounts: [],
			network: "none",
			allowedDomains: [],
			envPassthrough: [],
			setEnv: FIXTURE_GIT_ENV,
			toolchainPaths: [gitBinDir],
			workspaceGitdir: scope.commonDir,
			workspaceGitWritable: scope.writable,
			workspaceGitProtected: scope.protectedPaths,
		};
		const proc = await runSandboxed(profile, {
			argv: ["/bin/sh", "-c", `PATH=${gitBinDir}:$PATH; ${script}`],
		});
		const err = await Bun.readableStreamToText(proc.stderr);
		return { exit: await proc.exited, err };
	}

	test.skipIf(!canSandbox)(
		"commits on the run branch",
		async () => {
			const res = await sh("echo change > file && git add file && git commit -q -m agent");
			expect(res.exit).toBe(0);
			// macOS grants the packed-refs literals, so the commit is silent there;
			// Linux prints the documented packed-refs.lock noise (git-scope.ts).
			if (isDarwin) expect(res.err).toBe("");
			expect(fixtureGitCmd(fx.clone, "log", "-1", "--format=%s", "warren/run")).toBe("agent");
		},
		30_000,
	);

	test.skipIf(!canSandbox)(
		"cannot write clone config, hooks, admin binding files, or a sibling's index",
		async () => {
			resolveWorkspaceGitScope(fx.ws, fx.common); // creates config.worktree
			const admin = adminDirOf(fx.ws);
			const watched = [
				join(fx.common, "config"),
				join(admin, "commondir"),
				join(admin, "config.worktree"),
				join(adminDirOf(fx.sibling), "index"),
			];
			const before = watched.map((p) => readFileSync(p));
			const hook = join(fx.common, "hooks", "post-checkout");
			const probes = [
				"git config core.fsmonitor true",
				`echo x >> ${watched[0]}`,
				`echo x > ${hook}`,
				`echo /elsewhere > ${watched[1]}`,
				`echo '[core]' >> ${watched[2]}`,
				`rm -f ${watched[2]}`,
				`echo x > ${watched[3]}`,
				`ln ${watched[0]} ${join(fx.common, "objects", "cfg")}`,
			];
			for (const probe of probes) {
				expect((await sh(probe)).exit).not.toBe(0);
			}
			watched.forEach((p, i) => {
				expect(readFileSync(p).equals(before[i] ?? Buffer.alloc(0))).toBe(true);
			});
			expect(existsSync(hook)).toBe(false);
			expect(existsSync(join(fx.common, "objects", "cfg"))).toBe(false);
		},
		30_000,
	);

	test.skipIf(!canSandbox)(
		"cannot rename or remove a writable root, nor write objects/info",
		async () => {
			const admin = adminDirOf(fx.ws);
			const objects = join(fx.common, "objects");
			const probes = [
				`mv ${admin} ${admin}.x`,
				`mv ${admin} ${join(objects, "moved")}`,
				`mv ${objects} ${objects}.x`,
				`mv ${join(fx.common, "refs")} ${join(objects, "refs-moved")}`,
				`echo /elsewhere > ${join(objects, "info", "alternates")}`,
				`mv ${join(objects, "info")} ${join(objects, "info.x")}`,
			];
			for (const probe of probes) {
				expect((await sh(probe)).exit).not.toBe(0);
			}
			expect(readFileSync(join(admin, "commondir"), "utf8").length).toBeGreaterThan(0);
			// On Linux the admin dir is a separate mount, so `mv` falls back to
			// copy+unlink: the copy into writable objects/ lands, the unlink is
			// refused. The real admin dir stays intact (asserted above), which is
			// what host git reads; a stray copy under objects/ is inert.
			// The same fallback lets `mv refs ...` empty refs/ on Linux; refs/ is
			// writable by design there (shared-refs follow-up: warren-3c1e), so only
			// the mount point itself is guaranteed to survive.
			if (process.platform === "darwin") {
				expect(existsSync(join(objects, "moved"))).toBe(false);
				expect(existsSync(join(fx.common, "refs", "heads"))).toBe(true);
			}
			expect(existsSync(join(fx.common, "refs"))).toBe(true);
			expect(existsSync(join(objects, "info", "alternates"))).toBe(false);
		},
		30_000,
	);
});

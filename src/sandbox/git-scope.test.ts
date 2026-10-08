import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	FIXTURE_GIT_ENV,
	fixtureGitCmd,
	makePrivateGitFixture,
	type PrivateGitFixture,
} from "./git-scope.test-helpers.ts";
import {
	assertPrivateGitDirIntact,
	type PrivateGitScope,
	resolvePrivateGitScope,
	WorkspaceGitScopeError,
} from "./git-scope.ts";
import { runSandboxed } from "./sandbox.ts";
import type { SandboxProfile } from "./types.ts";

function scopeOf(fx: PrivateGitFixture, checkPointer = true): PrivateGitScope {
	return resolvePrivateGitScope({
		workspacePath: fx.ws,
		gitDir: fx.gitDir,
		hostGitDir: fx.hostGitDir,
		configSha256: fx.source.gitConfigSha256 ?? "",
		checkPointer,
	});
}

describe("materializePrivateGitDir (warren-3c1e)", () => {
	let fx: PrivateGitFixture;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("checks the base out against a private git dir borrowing the host objects", () => {
		expect(readFileSync(join(fx.ws, ".git"), "utf8").trim()).toBe(`gitdir: ${fx.gitDir}`);
		expect(readFileSync(join(fx.gitDir, "objects", "info", "alternates"), "utf8")).toBe(
			`${join(fx.hostGitDir, "objects")}\n`,
		);
		expect(readFileSync(join(fx.ws, "README"), "utf8")).toBe("hi\n");
		expect(fixtureGitCmd(fx.ws, "symbolic-ref", "HEAD")).toBe("refs/heads/warren/run");
		// The base snapshot is visible in the run; the run branch is not in the host.
		expect(fixtureGitCmd(fx.ws, "rev-parse", "main")).toBe(
			fixtureGitCmd(fx.clone, "rev-parse", "main"),
		);
		expect(fixtureGitCmd(fx.clone, "branch", "--list", "warren/*")).toBe("");
		expect(fixtureGitCmd(fx.ws, "config", "remote.origin.url")).toBe(
			"https://example.invalid/o/r.git",
		);
		expect(existsSync(join(fx.gitDir, "hooks"))).toBe(false);
	});
});

describe("resolvePrivateGitScope + assertPrivateGitDirIntact", () => {
	let fx: PrivateGitFixture;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("exposes the private git dir and only the host object store", () => {
		const scope = scopeOf(fx);
		expect(scope.gitDir).toBe(fx.gitDir);
		expect(scope.hostGitDir).toBe(fx.hostGitDir);
		expect(scope.sharedObjects).toBe(join(fx.hostGitDir, "objects"));
		expect(scope.protectedPaths).toEqual([
			join(fx.gitDir, "config"),
			join(fx.gitDir, "objects", "info", "alternates"),
		]);
	});

	test("rejects a workspace .git pointing at a sibling's git dir", () => {
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${fx.siblingGitDir}\n`);
		expect(() => scopeOf(fx)).toThrow(/does not point at/);
		// A re-pin after the run never consults .git.
		expect(() => scopeOf(fx, false)).not.toThrow();
	});

	test("rejects a symlink planted anywhere in the git dir", () => {
		const scope = scopeOf(fx);
		const secret = join(fx.root, "secret");
		writeFileSync(secret, "s\n");
		mkdirSync(join(fx.gitDir, "logs", "refs", "remotes"), { recursive: true });
		symlinkSync(secret, join(fx.gitDir, "logs", "refs", "remotes", "planted"));
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/is a symlink/);
	});

	test("rejects a symlinked object directory", () => {
		const scope = scopeOf(fx);
		symlinkSync(join(fx.siblingGitDir, "objects"), join(fx.gitDir, "objects", "ab"));
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(WorkspaceGitScopeError);
	});

	test("rejects a hard-linked file", () => {
		const scope = scopeOf(fx);
		const outside = join(fx.root, "outside");
		writeFileSync(outside, "x\n");
		linkSync(outside, join(fx.gitDir, "logs-hardlink"));
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/hard-linked/);
	});

	test("rejects a rewritten config, alternates, or a new commondir", () => {
		const scope = scopeOf(fx);
		const config = join(fx.gitDir, "config");
		const original = readFileSync(config);
		writeFileSync(config, `${original}[core]\n\tsshCommand = touch /tmp/x\n`);
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/config changed/);
		writeFileSync(config, original);

		const alternates = join(fx.gitDir, "objects", "info", "alternates");
		writeFileSync(alternates, `${join(fx.siblingGitDir, "objects")}\n`);
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/alternates changed/);
		writeFileSync(alternates, `${scope.sharedObjects}\n`);

		writeFileSync(join(fx.gitDir, "commondir"), `${fx.hostGitDir}\n`);
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/commondir/);
		rmSync(join(fx.gitDir, "commondir"));
		expect(() => assertPrivateGitDirIntact(scope)).not.toThrow();
	});

	test("rejects a git dir root swapped for a symlink", () => {
		const scope = scopeOf(fx);
		renameSync(fx.gitDir, `${fx.gitDir}.real`);
		symlinkSync(`${fx.gitDir}.real`, fx.gitDir);
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/real directory/);
	});

	test("rejects a host object store reached through a symlink", () => {
		const objects = join(fx.hostGitDir, "objects");
		renameSync(objects, `${objects}.real`);
		symlinkSync(`${objects}.real`, objects);
		expect(() => scopeOf(fx)).toThrow(/not a symlink/);
	});
});

// Real platform sandbox: the run owns its git dir (commits, ref updates and
// deletions all work), but cannot write its config/alternates, the host
// clone's git dir, or a sibling run's git dir. Linux bwrap runs these only
// where bwrap is installed.
const isDarwin = process.platform === "darwin";
const canSandbox = isDarwin || (process.platform === "linux" && Bun.which("bwrap") !== null);

describe("private git dir inside the real sandbox (warren-3c1e)", () => {
	let fx: PrivateGitFixture;
	let home: string;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
		home = join(fx.root, "home");
		mkdirSync(home);
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	async function sh(script: string): Promise<{ exit: number; err: string }> {
		const scope = scopeOf(fx);
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
			workspaceGit: {
				gitDir: scope.gitDir,
				protectedPaths: scope.protectedPaths,
				hostGitDir: scope.hostGitDir,
				sharedObjects: scope.sharedObjects,
				deniedRoots: [dirname(scope.gitDir)],
			},
		};
		const proc = await runSandboxed(profile, {
			argv: ["/bin/sh", "-c", `PATH=${gitBinDir}:$PATH; ${script}`],
		});
		const err = await Bun.readableStreamToText(proc.stderr);
		return { exit: await proc.exited, err };
	}

	test.skipIf(!canSandbox)(
		"commits, then creates and deletes loose and packed refs without errors",
		async () => {
			const res = await sh(
				[
					"set -e",
					"echo change > file && git add file && git commit -q -m agent",
					"git branch scratch && git branch -D scratch",
					"git tag t1 && git tag -d t1",
					// `main` lives in packed-refs: deleting it rewrites packed-refs.lock.
					"git branch -D main",
					"git update-ref -d refs/heads/warren/run-tmp 2>/dev/null || true",
				].join("\n"),
			);
			// `git branch -D` also tries to drop a `branch.<name>` config section;
			// config is read-only, so git warns and still deletes the ref. That
			// warning is the only stderr allowed: no ref or lock errors.
			const noise =
				/^(Deleted (branch|tag) .*|error: could not write config file .*|warning: update of config-file failed)\n/gim;
			expect(res.err.replace(noise, "")).toBe("");
			expect(res.exit).toBe(0);
			expect(fixtureGitCmd(fx.ws, "log", "-1", "--format=%s")).toBe("agent");
			// The host clone still has main and never saw the run's branch.
			expect(fixtureGitCmd(fx.clone, "branch", "--list", "main")).toContain("main");
			expect(fixtureGitCmd(fx.clone, "branch", "--list", "warren/*")).toBe("");
			const newObject = fixtureGitCmd(fx.ws, "rev-parse", "HEAD");
			const loose = join(fx.gitDir, "objects", newObject.slice(0, 2), newObject.slice(2));
			expect(existsSync(loose)).toBe(true);
		},
		30_000,
	);

	test.skipIf(!canSandbox)(
		"cannot move the host base branch or any host ref",
		async () => {
			const baseBefore = fixtureGitCmd(fx.clone, "rev-parse", "main");
			const hostRefs = fixtureGitCmd(fx.clone, "for-each-ref");
			// Moving `main` inside the run moves only the run's own copy.
			const own = await sh(
				"echo x > f && git add f && git commit -q -m agent && git branch -f main HEAD",
			);
			expect(own.exit).toBe(0);
			expect(fixtureGitCmd(fx.ws, "rev-parse", "main")).not.toBe(baseBefore);
			const probes = [
				`git --git-dir=${fx.hostGitDir} update-ref refs/heads/main HEAD`,
				`echo 0000000000000000000000000000000000000000 > ${join(fx.hostGitDir, "refs", "heads", "main")}`,
				`echo x >> ${join(fx.hostGitDir, "packed-refs")}`,
				`echo x >> ${join(fx.hostGitDir, "config")}`,
				`touch ${join(fx.hostGitDir, "objects", "planted")}`,
				`echo x > ${join(fx.siblingGitDir, "HEAD")}`,
				`git --git-dir=${fx.siblingGitDir} update-ref refs/heads/main HEAD`,
			];
			const watched = [
				join(fx.hostGitDir, "refs", "heads", "main"),
				join(fx.hostGitDir, "packed-refs"),
				join(fx.hostGitDir, "config"),
				join(fx.siblingGitDir, "HEAD"),
			];
			const snapshot = () => watched.map((p) => (existsSync(p) ? readFileSync(p, "utf8") : null));
			const before = snapshot();
			for (const probe of probes) {
				const { exit } = await sh(probe);
				// Seatbelt denies the write. bwrap never mounts these paths, so a
				// write lands in the sandbox's own scratch tree; the host files
				// below are what must not change.
				if (isDarwin) expect(exit).not.toBe(0);
			}
			expect(snapshot()).toEqual(before);
			expect(fixtureGitCmd(fx.clone, "rev-parse", "main")).toBe(baseBefore);
			expect(fixtureGitCmd(fx.clone, "for-each-ref")).toBe(hostRefs);
			expect(fixtureGitCmd(fx.sibling, "rev-parse", "main")).toBe(baseBefore);
			expect(existsSync(join(fx.hostGitDir, "objects", "planted"))).toBe(false);
		},
		30_000,
	);

	test.skipIf(!canSandbox)(
		"cannot write its config or alternates, nor rename its git dir",
		async () => {
			const config = join(fx.gitDir, "config");
			const alternates = join(fx.gitDir, "objects", "info", "alternates");
			const before = [readFileSync(config), readFileSync(alternates)];
			const probes = [
				"git config core.fsmonitor true",
				`echo x >> ${config}`,
				`rm -f ${config}`,
				`echo /elsewhere > ${alternates}`,
				`mv ${fx.gitDir} ${fx.gitDir}.x`,
			];
			for (const probe of probes) {
				expect((await sh(probe)).exit).not.toBe(0);
			}
			expect(readFileSync(config).equals(before[0] ?? Buffer.alloc(0))).toBe(true);
			expect(readFileSync(alternates).equals(before[1] ?? Buffer.alloc(0))).toBe(true);
			expect(() => assertPrivateGitDirIntact(scopeOf(fx))).not.toThrow();
		},
		30_000,
	);
});

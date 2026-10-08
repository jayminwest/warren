import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	FIXTURE_GIT_ENV,
	fixtureGitCmd,
	makePrivateGitFixture,
	type PrivateGitFixture,
} from "../../sandbox/git-scope.test-helpers.ts";
import {
	assertPrivateGitDirIntact,
	type PrivateGitScope,
	resolvePrivateGitScope,
} from "../../sandbox/git-scope.ts";
import {
	registerWorkspaceGitPin,
	unregisterWorkspaceGitPin,
} from "../../workspace/git/host-git.ts";
import { scrubbedGitEnv } from "../../workspace/git/test-fixture.ts";
import { defaultExec } from "./util.ts";

// GIT_* keys mapped to undefined so an inherited GIT_DIR cannot redirect.
function execEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...FIXTURE_GIT_ENV };
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
	}
	return env;
}

describe("defaultExec host-side git (warren-8926, warren-3c1e)", () => {
	let fx: PrivateGitFixture;
	let scope: PrivateGitScope;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
		scope = resolvePrivateGitScope({
			workspacePath: fx.ws,
			gitDir: fx.gitDir,
			hostGitDir: fx.hostGitDir,
			configSha256: fx.source.gitConfigSha256 ?? "",
		});
	});
	afterEach(() => {
		unregisterWorkspaceGitPin(fx.ws);
		rmSync(fx.root, { recursive: true, force: true });
	});

	function pin(): void {
		registerWorkspaceGitPin(fx.ws, {
			gitDir: scope.gitDir,
			commonDir: scope.gitDir,
			verify: () => assertPrivateGitDirIntact(scope),
		});
	}

	test("pins a registered workspace to its private git dir, ignoring a rewritten .git", async () => {
		pin();
		// The run rewrites its .git pointer at a repository it controls.
		const other = join(fx.root, "other");
		mkdirSync(other);
		fixtureGitCmd(other, "init", "-q");
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${join(other, ".git")}\n`);
		const out = await defaultExec.run("git", ["rev-parse", "--absolute-git-dir"], {
			cwd: fx.ws,
			env: execEnv(),
		});
		expect(out.stdout.trim()).toBe(scope.gitDir);
	});

	test("never runs hooks the run planted in its git dir on a host-side commit", async () => {
		pin();
		const marker = join(fx.root, "hook-ran");
		mkdirSync(join(fx.gitDir, "hooks"), { recursive: true });
		writeFileSync(join(fx.gitDir, "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, {
			mode: 0o755,
		});
		writeFileSync(join(fx.ws, "f"), "x\n");
		await defaultExec.run("git", ["add", "f"], { cwd: fx.ws, env: execEnv() });
		await defaultExec.run("git", ["commit", "-q", "-m", "reap"], { cwd: fx.ws, env: execEnv() });
		expect(fixtureGitCmd(fx.ws, "log", "-1", "--format=%s")).toBe("reap");
		expect(existsSync(marker)).toBe(false);
		// The commit landed in the private dir only, never in the host clone.
		expect(fixtureGitCmd(fx.clone, "branch", "--list", "warren/*")).toBe("");
		// Control: the same hook DOES fire for unhardened git.
		Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "ctl"], {
			cwd: fx.ws,
			env: { ...scrubbedGitEnv(), ...FIXTURE_GIT_ENV },
		});
		expect(existsSync(marker)).toBe(true);
	});

	test("refuses to run once the run rewrote its git config", async () => {
		pin();
		const filterMarker = join(fx.root, "filter-ran");
		const filter = join(fx.root, "filter.sh");
		writeFileSync(filter, `#!/bin/sh\ntouch ${filterMarker}\ncat\n`, { mode: 0o755 });
		writeFileSync(
			join(fx.gitDir, "config"),
			`[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = ${filter}\n`,
		);
		writeFileSync(join(fx.ws, ".gitattributes"), "* filter=x\n");
		writeFileSync(join(fx.ws, "f"), "x\n");
		await expect(
			defaultExec.run("git", ["add", "-A"], { cwd: fx.ws, env: execEnv() }),
		).rejects.toThrow(/config changed/);
		expect(existsSync(filterMarker)).toBe(false);
	});

	test("refuses to follow a symlink the run planted in its git dir", async () => {
		pin();
		const secret = join(fx.root, "secret");
		writeFileSync(secret, "untouched\n");
		mkdirSync(join(fx.gitDir, "logs", "refs", "heads", "warren"), { recursive: true });
		rmSync(join(fx.gitDir, "logs", "refs", "heads", "warren", "run"), { force: true });
		symlinkSync(secret, join(fx.gitDir, "logs", "refs", "heads", "warren", "run"));
		await expect(
			defaultExec.run("git", ["commit", "-q", "--allow-empty", "-m", "reap"], {
				cwd: fx.ws,
				env: execEnv(),
			}),
		).rejects.toThrow(/is a symlink/);
		expect(Bun.file(secret).size).toBe("untouched\n".length);
	});

	test("refuses an unregistered run workspace, from any subdirectory", async () => {
		await expect(
			defaultExec.run("git", ["status"], { cwd: fx.ws, env: execEnv() }),
		).rejects.toThrow(/no validated git dir pin/);
		const sub = join(fx.ws, "nested", "dir");
		mkdirSync(sub, { recursive: true });
		await expect(defaultExec.run("git", ["status"], { cwd: sub, env: execEnv() })).rejects.toThrow(
			/no validated git dir pin/,
		);
	});
});

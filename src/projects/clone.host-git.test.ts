import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSpawn } from "./clone.ts";

// Project-clone git (refresh: fetch / reset --hard) runs host-side; repo
// config must never make it execute a hook or fsmonitor (warren-8926).
describe("defaultSpawn host git hardening (warren-8926)", () => {
	let dir: string;
	const env: Record<string, string | undefined> = {
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@example.invalid",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@example.invalid",
	};
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "warren-clone-host-git-")));
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
		}
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("reset --hard runs neither post-checkout hooks nor an fsmonitor command", async () => {
		const repo = join(dir, "repo");
		mkdirSync(repo);
		const git = (...args: string[]) => defaultSpawn(["git", ...args], { cwd: repo, env });
		await git("init", "-q", "-b", "main");
		await git("commit", "-q", "--allow-empty", "-m", "init");
		const hooks = join(dir, "hooks");
		mkdirSync(hooks);
		const hookMarker = join(dir, "hook-ran");
		const fsmMarker = join(dir, "fsmonitor-ran");
		writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${hookMarker}\n`, {
			mode: 0o755,
		});
		const fsm = join(dir, "fsm.sh");
		writeFileSync(fsm, `#!/bin/sh\ntouch ${fsmMarker}\n`, { mode: 0o755 });
		await git("config", "core.hooksPath", hooks);
		await git("config", "core.fsmonitor", fsm);
		expect((await git("reset", "-q", "--hard", "HEAD")).exitCode).toBe(0);
		expect((await git("checkout", "-q", "-B", "side")).exitCode).toBe(0);
		expect((await git("status", "--porcelain")).exitCode).toBe(0);
		expect(existsSync(hookMarker)).toBe(false);
		expect(existsSync(fsmMarker)).toBe(false);
		// Control: unhardened git in the same repo fires both.
		const plainEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries({ ...process.env, ...env })) {
			if (v !== undefined) plainEnv[k] = v;
		}
		Bun.spawnSync(["git", "checkout", "-q", "-B", "main"], { cwd: repo, env: plainEnv });
		Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, env: plainEnv });
		expect(existsSync(hookMarker)).toBe(true);
		expect(existsSync(fsmMarker)).toBe(true);
	});
});

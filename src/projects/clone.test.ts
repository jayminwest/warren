import { describe, expect, test } from "bun:test";
import { cloneProjectRepo, type SpawnFn, type SpawnResult } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";

const CFG: ProjectsConfig = {
	root: "/data/projects",
	gitBinary: "git",
};

interface Recorded {
	cmd: readonly string[];
	cwd: string;
}

function recorder(handler: (cmd: readonly string[]) => SpawnResult): {
	spawn: SpawnFn;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const spawn: SpawnFn = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd });
		return handler(cmd);
	};
	return { spawn, calls };
}

function ok(stdout = ""): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

interface FsStubs {
	exists: (path: string) => boolean;
	mkdirp: (path: string) => Promise<void>;
	rmrf: (path: string) => Promise<void>;
	mkdirCalls: string[];
	rmCalls: string[];
}

function fsStubs(initialExists: (path: string) => boolean = () => false): FsStubs {
	const mkdirCalls: string[] = [];
	const rmCalls: string[] = [];
	return {
		exists: initialExists,
		mkdirp: async (p) => {
			mkdirCalls.push(p);
		},
		rmrf: async (p) => {
			rmCalls.push(p);
		},
		mkdirCalls,
		rmCalls,
	};
}

describe("cloneProjectRepo", () => {
	test("clones into <root>/<owner>/<name> and detects the default branch", async () => {
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "symbolic-ref") {
				return ok("refs/remotes/origin/main\n");
			}
			return ok();
		});
		const fs = fsStubs();
		const result = await cloneProjectRepo({
			config: CFG,
			gitUrl: "https://github.com/jayminwest/warren.git",
			owner: "jayminwest",
			name: "warren",
			spawn,
			exists: fs.exists,
			mkdirp: fs.mkdirp,
			rmrf: fs.rmrf,
		});

		expect(result).toEqual({
			localPath: "/data/projects/jayminwest/warren",
			defaultBranch: "main",
		});
		expect(fs.mkdirCalls).toEqual(["/data/projects/jayminwest"]);
		expect(fs.rmCalls).toEqual([]);
		expect(calls.map((c) => c.cmd[1])).toEqual(["clone", "symbolic-ref"]);
		expect(calls[0]?.cmd).toEqual([
			"git",
			"clone",
			"https://github.com/jayminwest/warren.git",
			"/data/projects/jayminwest/warren",
		]);
		expect(calls[1]?.cwd).toBe("/data/projects/jayminwest/warren");
	});

	test("respects an explicit defaultBranch override (skips symbolic-ref)", async () => {
		const { spawn, calls } = recorder(() => ok());
		const fs = fsStubs();
		const result = await cloneProjectRepo({
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			owner: "x",
			name: "y",
			defaultBranch: "trunk",
			spawn,
			exists: fs.exists,
			mkdirp: fs.mkdirp,
			rmrf: fs.rmrf,
		});

		expect(result.defaultBranch).toBe("trunk");
		expect(calls.map((c) => c.cmd[1])).toEqual(["clone"]);
	});

	test("falls back to remote set-head + retry when symbolic-ref fails initially", async () => {
		let symbolicRefCalls = 0;
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "symbolic-ref") {
				symbolicRefCalls += 1;
				return symbolicRefCalls === 1
					? { stdout: "", stderr: "no HEAD", exitCode: 1 }
					: ok("refs/remotes/origin/develop\n");
			}
			return ok();
		});
		const fs = fsStubs();
		const result = await cloneProjectRepo({
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			owner: "x",
			name: "y",
			spawn,
			exists: fs.exists,
			mkdirp: fs.mkdirp,
			rmrf: fs.rmrf,
		});

		expect(result.defaultBranch).toBe("develop");
		expect(symbolicRefCalls).toBe(2);
		expect(calls.some((c) => c.cmd.includes("set-head"))).toBe(true);
	});

	test("refuses to clone when the target path already exists", async () => {
		const { spawn } = recorder(() => ok());
		const fs = fsStubs((p) => p === "/data/projects/x/y");
		await expect(
			cloneProjectRepo({
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				owner: "x",
				name: "y",
				spawn,
				exists: fs.exists,
				mkdirp: fs.mkdirp,
				rmrf: fs.rmrf,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(fs.mkdirCalls).toEqual([]);
	});

	test("throws ProjectUnavailableError on git clone failure and cleans up the partial dir", async () => {
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "clone") {
				return { stdout: "", stderr: "fatal: repository not found", exitCode: 128 };
			}
			return ok();
		});
		const fs = fsStubs();
		await expect(
			cloneProjectRepo({
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				owner: "x",
				name: "y",
				spawn,
				exists: fs.exists,
				mkdirp: fs.mkdirp,
				rmrf: fs.rmrf,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(calls.map((c) => c.cmd[1])).toEqual(["clone"]);
		expect(fs.rmCalls).toEqual(["/data/projects/x/y"]);
	});

	test("throws ProjectUnavailableError when default-branch detection fails and cleans up", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "symbolic-ref" || cmd.includes("set-head")) {
				return { stdout: "", stderr: "no remote HEAD", exitCode: 128 };
			}
			return ok();
		});
		const fs = fsStubs();
		await expect(
			cloneProjectRepo({
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				owner: "x",
				name: "y",
				spawn,
				exists: fs.exists,
				mkdirp: fs.mkdirp,
				rmrf: fs.rmrf,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(fs.rmCalls).toEqual(["/data/projects/x/y"]);
	});

	test("wraps spawn-level failures (e.g. ENOENT for git binary) as ProjectUnavailableError", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT: git not found");
		};
		const fs = fsStubs();
		await expect(
			cloneProjectRepo({
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				owner: "x",
				name: "y",
				spawn,
				exists: fs.exists,
				mkdirp: fs.mkdirp,
				rmrf: fs.rmrf,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("token → clone + set-head spawns carry the credential env; token stays out of argv", async () => {
		const envs: (Record<string, string | undefined> | undefined)[] = [];
		const cmds: (readonly string[])[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			cmds.push(cmd);
			envs.push(opts.env);
			// First symbolic-ref misses so the set-head recovery path runs.
			if (cmd[1] === "symbolic-ref") {
				return cmds.filter((c) => c[1] === "symbolic-ref").length === 1
					? { stdout: "", stderr: "no HEAD", exitCode: 1 }
					: ok("refs/remotes/origin/main\n");
			}
			return ok();
		};
		const fs = fsStubs();
		await cloneProjectRepo({
			config: CFG,
			gitUrl: "https://github.com/x/private.git",
			owner: "x",
			name: "private",
			gitCredential: { username: "x-access-token", secret: "ghp_secret", host: "github.com" },
			spawn,
			exists: fs.exists,
			mkdirp: fs.mkdirp,
			rmrf: fs.rmrf,
		});

		expect(cmds.map((c) => c[1])).toEqual(["clone", "symbolic-ref", "remote", "symbolic-ref"]);
		const expectedCred = {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://x-access-token:ghp_secret@github.com/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://github.com/",
		};
		expect(envs[0]).toEqual(expectedCred); // clone
		expect(envs[2]).toEqual(expectedCred); // remote set-head (network recovery)
		// The token never rides in argv — env-based config only.
		expect(cmds.flat().join(" ")).not.toContain("ghp_secret");
	});

	test("no token → spawns receive no env override (anonymous clone unchanged)", async () => {
		const envs: (Record<string, string | undefined> | undefined)[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			envs.push(opts.env);
			if (cmd[1] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
			return ok();
		};
		const fs = fsStubs();
		await cloneProjectRepo({
			config: CFG,
			gitUrl: "https://github.com/x/public.git",
			owner: "x",
			name: "public",
			spawn,
			exists: fs.exists,
			mkdirp: fs.mkdirp,
			rmrf: fs.rmrf,
		});
		expect(envs.every((e) => e === undefined)).toBe(true);
	});
});

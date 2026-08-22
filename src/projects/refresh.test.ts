import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "./clone.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { CFG, ok, recorder } from "./refresh.test-helpers.ts";
import {
	detectHooksPathFromPackageJson,
	detectProjectFeatures,
	refreshProjectClone,
} from "./refresh.ts";

describe("refreshProjectClone", () => {
	test("fetches, checks out ref, hard-resets to origin/<ref>, scrubs stale user identity, and returns HEAD sha", async () => {
		const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
		});

		expect(result).toEqual({
			headSha: sha,
			ref: "main",
			features: { hasSeeds: true, hasMulch: true },
		});
		expect(calls.map((c) => c.cmd[1])).toEqual([
			"fetch",
			"checkout",
			"reset",
			"config",
			"config",
			"rev-parse",
		]);
		expect(calls[0]?.cmd).toEqual(["git", "fetch", "--prune", "origin"]);
		expect(calls[1]?.cmd).toEqual(["git", "checkout", "--force", "main"]);
		expect(calls[2]?.cmd).toEqual(["git", "reset", "--hard", "origin/main"]);
		expect(calls[3]?.cmd).toEqual(["git", "config", "--local", "--unset-all", "user.name"]);
		expect(calls[4]?.cmd).toEqual(["git", "config", "--local", "--unset-all", "user.email"]);
		expect(calls.every((c) => c.cwd === "/data/projects/x/y")).toBe(true);
	});

	test("tolerates the user identity scrub exiting non-zero when keys are absent (warren-9f70)", async () => {
		const sha = "abcabcabcabcabcabcabcabcabcabcabcabcabca";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "config" && cmd.includes("--unset-all")) {
				// Real git exits 5 ("no such key") when the key is absent —
				// the normal case for clean clones.
				return { stdout: "", stderr: "", exitCode: 5 };
			}
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
		});

		expect(result.headSha).toBe(sha);
		// rev-parse still runs after a failed unset: the scrub is
		// best-effort and must not abort the refresh.
		expect(calls.map((c) => c.cmd[1])).toContain("rev-parse");
	});

	test("falls back to plain reset --hard <ref> when origin/<ref> does not resolve", async () => {
		const sha = "1111111111111111111111111111111111111111";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "reset" && cmd[3] === "origin/v1.2.3") {
				return { stdout: "", stderr: "unknown revision", exitCode: 128 };
			}
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "v1.2.3",
			spawn,
			exists: () => true,
		});

		expect(result.headSha).toBe(sha);
		const resetCalls = calls.filter((c) => c.cmd[1] === "reset");
		expect(resetCalls.map((c) => c.cmd[3])).toEqual(["origin/v1.2.3", "v1.2.3"]);
	});

	test("token → the fetch spawn carries the credential env; local git ops stay clean", async () => {
		const sha = "2222222222222222222222222222222222222222";
		const seen: { cmd: readonly string[]; env?: Record<string, string | undefined> }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			seen.push({ cmd, ...(opts.env !== undefined ? { env: opts.env } : {}) });
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		};
		await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			gitCredential: { username: "x-access-token", secret: "ghp_secret", host: "github.com" },
			spawn,
			exists: () => true,
		});

		const fetch = seen.find((c) => c.cmd[1] === "fetch");
		expect(fetch?.env).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://x-access-token:ghp_secret@github.com/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://github.com/",
		});
		// checkout / reset / config / rev-parse are local — no env override.
		expect(seen.filter((c) => c.cmd[1] !== "fetch").every((c) => c.env === undefined)).toBe(true);
		// Token never rides in argv.
		expect(seen.flatMap((c) => c.cmd).join(" ")).not.toContain("ghp_secret");
	});

	test("no token → the fetch spawn receives no env override", async () => {
		const sha = "3333333333333333333333333333333333333333";
		const seen: { cmd: readonly string[]; env?: Record<string, string | undefined> }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			seen.push({ cmd, ...(opts.env !== undefined ? { env: opts.env } : {}) });
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		};
		await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
		});
		expect(seen.find((c) => c.cmd[1] === "fetch")?.env).toBeUndefined();
	});

	test("throws ProjectUnavailableError when localPath does not exist", async () => {
		const { spawn } = recorder(() => ok());
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/missing",
				ref: "main",
				spawn,
				exists: () => false,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("throws ProjectUnavailableError when fetch fails", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "fetch") {
				return { stdout: "", stderr: "fatal: could not read", exitCode: 128 };
			}
			return ok();
		});
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("wraps spawn-level failures (e.g. ENOENT for git binary) as ProjectUnavailableError", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT: git not found");
		};
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("probes for .seeds/ alongside git ops and surfaces the boolean on features (warren-9990)", async () => {
		const sha = "abadcafeabadcafeabadcafeabadcafeabadcafe";
		const probed: string[] = [];
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: (p) => {
				probed.push(p);
				if (p === "/data/projects/x/y") return true;
				if (p === "/data/projects/x/y/.seeds") return true;
				return false;
			},
		});

		expect(result.features).toEqual({ hasSeeds: true, hasMulch: false });
		expect(probed).toContain("/data/projects/x/y/.seeds");
	});

	test("throws ProjectUnavailableError when rev-parse returns empty", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok("\n");
			return ok();
		});
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});
});

describe("detectProjectFeatures", () => {
	test("returns hasSeeds=false when .seeds/ is absent", () => {
		const result = detectProjectFeatures("/data/projects/x/y", () => false);
		expect(result).toEqual({ hasSeeds: false, hasMulch: false });
	});

	test("returns hasSeeds=true when .seeds/ exists at the clone root (warren-9990)", () => {
		const probed: string[] = [];
		const result = detectProjectFeatures("/data/projects/x/y", (p) => {
			probed.push(p);
			return p === "/data/projects/x/y/.seeds";
		});
		expect(result).toEqual({ hasSeeds: true, hasMulch: false });
		expect(probed).toContain("/data/projects/x/y/.seeds");
	});
});

describe("detectHooksPathFromPackageJson (warren-8f4c)", () => {
	test("extracts hooksPath from standard prepare script", () => {
		const pkg = {
			scripts: { prepare: "[ -e .git ] && git config core.hooksPath scripts/hooks || true" },
		};
		expect(detectHooksPathFromPackageJson(pkg)).toBe("scripts/hooks");
	});

	test("extracts hooksPath from prepare script with --local flag", () => {
		const pkg = { scripts: { prepare: "git config --local core.hooksPath .githooks" } };
		expect(detectHooksPathFromPackageJson(pkg)).toBe(".githooks");
	});

	test("returns undefined when prepare is absent", () => {
		expect(detectHooksPathFromPackageJson({ scripts: { build: "tsc" } })).toBeUndefined();
	});

	test("returns undefined when scripts is absent", () => {
		expect(detectHooksPathFromPackageJson({ name: "my-pkg" })).toBeUndefined();
	});

	test("returns undefined when prepare has no git config hooksPath", () => {
		const pkg = { scripts: { prepare: "husky install" } };
		expect(detectHooksPathFromPackageJson(pkg)).toBeUndefined();
	});

	test("returns undefined for null input", () => {
		expect(detectHooksPathFromPackageJson(null)).toBeUndefined();
	});

	test("returns undefined for non-object input", () => {
		expect(detectHooksPathFromPackageJson("string")).toBeUndefined();
	});
});

describe("refreshProjectClone git-hooks arming (warren-8f4c)", () => {
	test("applies core.hooksPath when package.json prepare script matches", async () => {
		const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const pkg = JSON.stringify({
			scripts: { prepare: "git config core.hooksPath scripts/hooks || true" },
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
			readFileFn: async () => pkg,
		});

		expect(result.headSha).toBe(sha);
		const hookCmd = calls.find(
			(c) =>
				c.cmd[1] === "config" &&
				c.cmd.includes("core.hooksPath") &&
				c.cmd.includes("scripts/hooks"),
		);
		expect(hookCmd).toBeDefined();
		expect(hookCmd?.cmd).toEqual(["git", "config", "--local", "core.hooksPath", "scripts/hooks"]);
	});

	test("skips hook arming when armHooks is false", async () => {
		const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const pkg = JSON.stringify({ scripts: { prepare: "git config core.hooksPath scripts/hooks" } });
		await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
			armHooks: false,
			readFileFn: async () => pkg,
		});

		const hookCmds = calls.filter((c) => c.cmd.includes("core.hooksPath"));
		expect(hookCmds).toHaveLength(0);
	});

	test("skips hook arming when package.json has no matching prepare script", async () => {
		const sha = "cccccccccccccccccccccccccccccccccccccccc";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const pkg = JSON.stringify({ scripts: { build: "tsc" } });
		await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
			readFileFn: async () => pkg,
		});

		const hookCmds = calls.filter((c) => c.cmd.includes("core.hooksPath"));
		expect(hookCmds).toHaveLength(0);
	});

	test("silently skips hook arming when readFileFn throws", async () => {
		const sha = "dddddddddddddddddddddddddddddddddddddddd";
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
			readFileFn: async () => {
				throw new Error("ENOENT");
			},
		});

		// Run must succeed even when package.json is unreadable.
		expect(result.headSha).toBe(sha);
	});
});

describe("refreshProjectClone: fetch-only mode (warren-232d)", () => {
	const PIN = "0123456789abcdef0123456789abcdef01234567";
	const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

	test("fetches the pinned sha, verifies it, and never moves HEAD (no checkout/reset)", async () => {
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${HEAD}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			fetchCommit: PIN,
			spawn,
			exists: () => true,
		});

		// headSha is the clone's UNCHANGED HEAD; ref echoes the pin.
		expect(result).toEqual({
			headSha: HEAD,
			ref: PIN,
			features: { hasSeeds: true, hasMulch: true },
		});
		expect(calls.map((c) => c.cmd.slice(0, 2))).toEqual([
			["git", "fetch"],
			["git", "cat-file"],
			["git", "rev-parse"],
		]);
		expect(calls[0]?.cmd).toEqual(["git", "fetch", "origin", PIN]);
		expect(calls[1]?.cmd).toEqual(["git", "cat-file", "-e", `${PIN}^{commit}`]);
		// Detached-HEAD safety: the shared clone's checked-out branch never moves.
		const verbs = calls.map((c) => c.cmd[1]);
		expect(verbs).not.toContain("checkout");
		expect(verbs).not.toContain("reset");
	});

	test("falls back to a full fetch when the server rejects the sha fetch (no allowReachableSHA1InWant)", async () => {
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "fetch" && cmd.includes(PIN)) {
				return { stdout: "", stderr: "Server does not allow request", exitCode: 128 };
			}
			if (cmd[1] === "rev-parse") return ok(`${HEAD}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			fetchCommit: PIN,
			spawn,
			exists: () => true,
		});

		expect(result.headSha).toBe(HEAD);
		expect(calls.map((c) => c.cmd)).toEqual([
			["git", "fetch", "origin", PIN],
			["git", "fetch", "--prune", "origin"],
			["git", "cat-file", "-e", `${PIN}^{commit}`],
			["git", "rev-parse", "HEAD"],
		]);
	});

	test("aborts when the pinned commit is not on origin", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "cat-file") {
				return { stdout: "", stderr: "bad object", exitCode: 128 };
			}
			if (cmd[1] === "rev-parse") return ok(`${HEAD}\n`);
			return ok();
		});
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				fetchCommit: PIN,
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});
});

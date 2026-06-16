import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "../projects/clone.ts";
import { captureSpawnCalls } from "./checks.test-helpers.ts";
import { checkBwrap, checkCanopyClean, checkCanopyClone } from "./checks.ts";

describe("checkBwrap", () => {
	test("ok when bwrap --version exits 0", async () => {
		const { spawn, calls } = captureSpawnCalls({
			bwrap: { stdout: "bubblewrap 0.8.0\n", exitCode: 0 },
		});
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("bubblewrap 0.8.0");
		expect(calls[0]?.cmd).toEqual(["bwrap", "--version"]);
	});

	test("fails with the bubblewrap install hint when exit non-zero", async () => {
		const { spawn } = captureSpawnCalls({
			bwrap: { stderr: "command not found", exitCode: 127 },
		});
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("127");
		expect(result.hint).toContain("bubblewrap");
	});

	test("fails with hint when spawn throws (binary missing)", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT bwrap");
		};
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("ENOENT");
		expect(result.hint).toContain("bubblewrap");
	});

	test("respects bwrapBinary override", async () => {
		const { spawn, calls } = captureSpawnCalls({
			"/usr/local/bin/bwrap": { stdout: "bubblewrap 0.8.0", exitCode: 0 },
		});
		await checkBwrap({ spawn, bwrapBinary: "/usr/local/bin/bwrap" });
		expect(calls[0]?.cmd).toEqual(["/usr/local/bin/bwrap", "--version"]);
	});
});

describe("checkCanopyClone", () => {
	test("ok with informational message when CANOPY_REPO_URL unset (warren-d3e9)", () => {
		const result = checkCanopyClone({ env: {}, exists: () => true });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no canopy library configured");
	});

	test("fails when the local dir does not exist", () => {
		const result = checkCanopyClone({
			env: { CANOPY_REPO_URL: "https://x/y.git", WARREN_CANOPY_DIR: "/missing" },
			exists: () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("/missing");
		expect(result.hint).toContain("/agents/refresh");
	});

	test("ok when local dir exists", () => {
		const result = checkCanopyClone({
			env: { CANOPY_REPO_URL: "https://x/y.git", WARREN_CANOPY_DIR: "/cn" },
			exists: () => true,
		});
		expect(result.ok).toBe(true);
		expect(result.message).toBe("/cn");
	});
});

describe("checkCanopyClean", () => {
	const baseEnv = { CANOPY_REPO_URL: "https://x/y.git", WARREN_CANOPY_DIR: "/cn" };

	test("ok with informational message when CANOPY_REPO_URL unset (warren-d3e9)", async () => {
		const { spawn, calls } = captureSpawnCalls({});
		const result = await checkCanopyClean({ env: {}, spawn, exists: () => true });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no canopy library configured");
		expect(calls.length).toBe(0);
	});

	test("fails when the local dir does not exist", async () => {
		const { spawn, calls } = captureSpawnCalls({});
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => false });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("/cn");
		// Should not shell out when the dir is missing.
		expect(calls.length).toBe(0);
	});

	test("ok when git status --porcelain is empty", async () => {
		const { spawn, calls } = captureSpawnCalls({
			git: { stdout: "", exitCode: 0 },
		});
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => true });
		expect(result.ok).toBe(true);
		expect(calls[0]?.cmd).toEqual(["git", "status", "--porcelain"]);
		expect(calls[0]?.cwd).toBe("/cn");
	});

	test("fails with mutation count when porcelain reports dirt", async () => {
		const { spawn } = captureSpawnCalls({
			git: { stdout: " M a.md\n?? b\n", exitCode: 0 },
		});
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("2 local mutation");
		expect(result.hint).toContain("/agents/refresh");
	});

	test("fails when git exits non-zero", async () => {
		const { spawn } = captureSpawnCalls({
			git: { stderr: "fatal: not a git repository", exitCode: 128 },
		});
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("128");
	});

	test("fails when spawn itself throws", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT git");
		};
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("ENOENT");
	});

	test("uses configured gitBinary", async () => {
		const { spawn, calls } = captureSpawnCalls({
			"/opt/git": { stdout: "", exitCode: 0 },
		});
		await checkCanopyClean({
			env: { ...baseEnv, WARREN_GIT_BINARY: "/opt/git" },
			spawn,
			exists: () => true,
		});
		expect(calls[0]?.cmd[0]).toBe("/opt/git");
	});
});

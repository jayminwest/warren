import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import type { SpawnOptions } from "../projects/clone.ts";
import { assertBranchOnRemote, validateExistingBranchShape } from "./target-branch.ts";

/**
 * warren-326f: `existingBranch` shape validation (grammar, default-branch
 * refusal, exclusivity) and the fail-closed remote-existence probe. The
 * probe runs BEFORE any side effect, so a missing branch is a clean 400.
 */
describe("validateExistingBranchShape", () => {
	const base = {
		targetBranch: undefined,
		ref: undefined,
		defaultBranch: "main",
		parentRunId: undefined,
	};

	test("returns undefined when the field is absent or whitespace", () => {
		expect(validateExistingBranchShape({ ...base, existingBranch: undefined })).toBeUndefined();
		expect(validateExistingBranchShape({ ...base, existingBranch: "   " })).toBeUndefined();
	});

	test("normalizes refs/heads/ and returns the short name", () => {
		expect(validateExistingBranchShape({ ...base, existingBranch: "refs/heads/fix/pr-head" })).toBe(
			"fix/pr-head",
		);
	});

	test("rejects an invalid git ref", () => {
		expect(() => validateExistingBranchShape({ ...base, existingBranch: "bad..branch" })).toThrow(
			ValidationError,
		);
	});

	test("rejects the project default branch (same policy as targetBranch)", () => {
		expect(() => validateExistingBranchShape({ ...base, existingBranch: "main" })).toThrow(
			/direct pushes to it are refused/,
		);
	});

	test("rejects conflicts with ref, targetBranch, and parentRunId", () => {
		expect(() =>
			validateExistingBranchShape({ ...base, existingBranch: "fix/x", ref: "release/v2" }),
		).toThrow(/ref/);
		expect(() =>
			validateExistingBranchShape({
				...base,
				existingBranch: "fix/x",
				targetBranch: "fix/y",
			}),
		).toThrow(/targetBranch/);
		expect(() =>
			validateExistingBranchShape({
				...base,
				existingBranch: "fix/x",
				parentRunId: "run_abc",
			}),
		).toThrow(/parentRunId/);
	});
});

describe("assertBranchOnRemote", () => {
	const spawnOk = async (cmd: readonly string[]) => {
		void cmd;
		return { stdout: "abc123\trefs/heads/fix/pr-head\n", stderr: "", exitCode: 0 };
	};

	test("passes when the remote carries the branch", async () => {
		await expect(
			assertBranchOnRemote({
				gitUrl: "https://github.com/x/y.git",
				branch: "fix/pr-head",
				spawn: spawnOk,
				cwd: "/tmp",
			}),
		).resolves.toBeUndefined();
	});

	test("fails closed when the branch is absent from the remote", async () => {
		await expect(
			assertBranchOnRemote({
				gitUrl: "https://github.com/x/y.git",
				branch: "ghost/branch",
				spawn: spawnOk,
				cwd: "/tmp",
			}),
		).rejects.toThrow(/does not exist on the push remote/);
	});

	test("fails closed when the probe itself fails", async () => {
		await expect(
			assertBranchOnRemote({
				gitUrl: "https://github.com/x/y.git",
				branch: "fix/pr-head",
				spawn: async () => ({ stdout: "", stderr: "auth", exitCode: 128 }),
				cwd: "/tmp",
			}),
		).rejects.toThrow(/ls-remote exited 128/);
	});

	test("builds the ls-remote command against the push URL and applies credential env", async () => {
		let received: { cmd?: readonly string[]; opts?: SpawnOptions } = {};
		await assertBranchOnRemote({
			gitUrl: "https://github.com/x/y.git",
			branch: "fix/pr-head",
			spawn: async (cmd, opts) => {
				received = { cmd, opts };
				return { stdout: "abc123\trefs/heads/fix/pr-head\n", stderr: "", exitCode: 0 };
			},
			gitCredential: { username: "x-access-token", secret: "tok", host: "github.com" },
			cwd: "/tmp",
		});
		expect(received.cmd?.slice(0, 2)).toEqual(["git", "ls-remote"]);
		expect(received.cmd?.[2]).toBe("--heads");
		expect(received.cmd?.[3]).toBe("https://github.com/x/y.git");
		expect(received.cmd?.[4]).toBe("refs/heads/fix/pr-head");
		expect(received.opts?.env?.GIT_CONFIG_COUNT).toBe("1");
	});
});

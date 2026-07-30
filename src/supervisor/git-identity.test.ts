import { describe, expect, test } from "bun:test";
import { defaultGitIdentityRun, type GitIdentityRun, installGitAuthor } from "./git-identity.ts";
import type { SupervisorLogger } from "./main.ts";

interface LoggedCall {
	level: "info" | "warn" | "error";
	obj: object;
	msg?: string;
}

function makeLogger(): { logger: SupervisorLogger; logs: LoggedCall[] } {
	const logs: LoggedCall[] = [];
	const logger: SupervisorLogger = {
		info: (obj, msg) => logs.push({ level: "info", obj, msg }),
		warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
		error: (obj, msg) => logs.push({ level: "error", obj, msg }),
	};
	return { logger, logs };
}

function makeRun(): {
	run: GitIdentityRun;
	calls: { cmd: string; args: readonly string[] }[];
} {
	const calls: { cmd: string; args: readonly string[] }[] = [];
	const run: GitIdentityRun = async (cmd, args) => {
		calls.push({ cmd, args });
		return { exitCode: 0, stdout: "", stderr: "" };
	};
	return { run, calls };
}

describe("installGitAuthor", () => {
	test("no-op when both env vars unset", async () => {
		const { logger, logs } = makeLogger();
		const { run, calls } = makeRun();
		const env: Record<string, string | undefined> = {};

		const result = await installGitAuthor(
			{ run, logger, env },
			{ authorName: undefined, authorEmail: undefined },
		);

		expect(result.installed).toBe(false);
		expect(calls).toHaveLength(0);
		expect(env.GIT_AUTHOR_NAME).toBeUndefined();
		expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
		expect(logs[0]?.msg).toContain("WARREN_GIT_AUTHOR_NAME/EMAIL unset");
		expect(logs[0]?.level).toBe("warn");
	});

	test("no-op when only one of the pair is set, with a distinct half-set warning", async () => {
		const { logger, logs } = makeLogger();
		const { run, calls } = makeRun();
		const env: Record<string, string | undefined> = {};

		const result = await installGitAuthor(
			{ run, logger, env },
			{ authorName: "Warren", authorEmail: undefined },
		);

		expect(result.installed).toBe(false);
		expect(calls).toHaveLength(0);
		expect(env.GIT_AUTHOR_NAME).toBeUndefined();
		expect(logs[0]?.level).toBe("warn");
		expect(logs[0]?.msg).toContain("half-set");
		expect(logs[0]?.obj).toEqual({ nameSet: true, emailSet: false });
	});

	test("treats whitespace-only values as unset", async () => {
		const { logger } = makeLogger();
		const { run, calls } = makeRun();
		const env: Record<string, string | undefined> = {};

		const result = await installGitAuthor(
			{ run, logger, env },
			{ authorName: "  ", authorEmail: "  " },
		);

		expect(result.installed).toBe(false);
		expect(calls).toHaveLength(0);
		expect(env.GIT_AUTHOR_NAME).toBeUndefined();
	});

	test("writes user.name/user.email via git config --global and exports env", async () => {
		const { logger, logs } = makeLogger();
		const { run, calls } = makeRun();
		const env: Record<string, string | undefined> = {};

		const result = await installGitAuthor(
			{ run, logger, env },
			{
				authorName: "Warren",
				authorEmail: "1234+warren@users.noreply.github.com",
			},
		);

		expect(result.installed).toBe(true);
		expect(calls).toEqual([
			{ cmd: "git", args: ["config", "--global", "user.name", "Warren"] },
			{
				cmd: "git",
				args: ["config", "--global", "user.email", "1234+warren@users.noreply.github.com"],
			},
		]);
		expect(env.GIT_AUTHOR_NAME).toBe("Warren");
		expect(env.GIT_AUTHOR_EMAIL).toBe("1234+warren@users.noreply.github.com");
		expect(env.GIT_COMMITTER_NAME).toBe("Warren");
		expect(env.GIT_COMMITTER_EMAIL).toBe("1234+warren@users.noreply.github.com");
		expect(logs.at(-1)?.msg).toContain("installed git identity");
	});

	test("trims surrounding whitespace before writing", async () => {
		const { logger } = makeLogger();
		const { run, calls } = makeRun();
		const env: Record<string, string | undefined> = {};

		await installGitAuthor(
			{ run, logger, env },
			{ authorName: "  Warren  ", authorEmail: "  warren@example.com  " },
		);

		expect(calls[0]?.args[3]).toBe("Warren");
		expect(calls[1]?.args[3]).toBe("warren@example.com");
		expect(env.GIT_AUTHOR_NAME).toBe("Warren");
		expect(env.GIT_AUTHOR_EMAIL).toBe("warren@example.com");
	});

	test("respects the gitBinary override", async () => {
		const { logger } = makeLogger();
		const { run, calls } = makeRun();
		const env: Record<string, string | undefined> = {};

		await installGitAuthor(
			{ run, logger, env },
			{
				authorName: "Warren",
				authorEmail: "warren@example.com",
				gitBinary: "/usr/local/bin/git",
			},
		);

		expect(calls[0]?.cmd).toBe("/usr/local/bin/git");
		expect(calls[1]?.cmd).toBe("/usr/local/bin/git");
	});

	test("throws on non-zero exit from user.name and does not mutate env", async () => {
		const { logger } = makeLogger();
		const env: Record<string, string | undefined> = {};
		const run: GitIdentityRun = async () => ({
			exitCode: 128,
			stdout: "",
			stderr: "fatal: $HOME not set",
		});

		const promise = installGitAuthor(
			{ run, logger, env },
			{ authorName: "Warren", authorEmail: "warren@example.com" },
		);

		await expect(promise).rejects.toThrow(/git config --global user.name failed \(exit 128\)/);
		expect(env.GIT_AUTHOR_NAME).toBeUndefined();
	});

	test("throws on non-zero exit from user.email after user.name succeeds", async () => {
		const { logger } = makeLogger();
		const env: Record<string, string | undefined> = {};
		let callIndex = 0;
		const run: GitIdentityRun = async () => {
			callIndex += 1;
			if (callIndex === 1) return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 5, stdout: "", stderr: "bad config key" };
		};

		const promise = installGitAuthor(
			{ run, logger, env },
			{ authorName: "Warren", authorEmail: "warren@example.com" },
		);

		await expect(promise).rejects.toThrow(/git config --global user.email failed \(exit 5\)/);
		// Env mutation is gated on both config writes succeeding.
		expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
	});
});

describe("defaultGitIdentityRun", () => {
	test("returns exitCode 0 + stdout for a successful command", async () => {
		const result = await defaultGitIdentityRun("/bin/sh", ["-c", "echo hi"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hi");
	});

	test("returns the non-zero exit code with stderr for a failing command", async () => {
		const result = await defaultGitIdentityRun("/bin/sh", ["-c", "echo bad 1>&2; exit 3"]);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("bad");
	});
});

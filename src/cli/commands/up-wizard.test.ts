import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../output.ts";
import {
	loadWizardEnv,
	parseWizardEnv,
	runUpWizard,
	type UpWizardDeps,
	wizardCredentialState,
	wizardEnvPath,
	writeWizardEnv,
} from "./up-wizard.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "warren-wizard-"));

function freshHome(): string {
	return mkdtempSync(join(tmpRoot, "home-"));
}

function captureContext(env: Record<string, string> = {}): {
	context: CliContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	return {
		context: {
			env,
			stdio: {
				stdout: { write: (c: string) => out.push(c) },
				stderr: { write: (c: string) => err.push(c) },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		out,
		err,
	};
}

function wizardDeps(home: string, over: Partial<UpWizardDeps> = {}): UpWizardDeps {
	return {
		homeDir: () => home,
		isInteractive: () => true,
		prompt: async () => {
			throw new Error("unexpected prompt");
		},
		runCommand: async () => ({ stdout: "", exitCode: 1 }),
		hasBinary: () => false,
		fetchGitHubLogin: async () => undefined,
		...over,
	};
}

describe("parseWizardEnv", () => {
	test("reads KEY=VALUE lines and skips comments, blanks, and malformed lines", () => {
		const parsed = parseWizardEnv("# comment\n\nA=1\n B = 2 \nno-equals\nEMPTY=\nC=x=y\n");
		expect(parsed).toEqual({ A: "1", B: "2", C: "x=y" });
	});
});

describe("writeWizardEnv / loadWizardEnv", () => {
	test("writes the file mode 0600 with a 0700 directory", () => {
		const home = freshHome();
		const path = wizardEnvPath(home);
		writeWizardEnv(path, { WARREN_GIT_TOKEN: "ghp_test", ANTHROPIC_API_KEY: "sk-test" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(home, ".warren")).mode & 0o777).toBe(0o700);
		expect(loadWizardEnv(path)).toEqual({
			WARREN_GIT_TOKEN: "ghp_test",
			ANTHROPIC_API_KEY: "sk-test",
		});
	});

	test("tightens a pre-existing wider mode back to 0600", () => {
		const home = freshHome();
		const path = wizardEnvPath(home);
		writeWizardEnv(path, { ANTHROPIC_API_KEY: "sk-test" });
		writeFileSync(path, "ANTHROPIC_API_KEY=sk-test\n", { mode: 0o644 });
		writeWizardEnv(path, { ANTHROPIC_API_KEY: "sk-test", CLAUDE_CODE_OAUTH_TOKEN: "oat" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("loads an absent file as empty", () => {
		expect(loadWizardEnv(join(freshHome(), ".warren", "env"))).toEqual({});
	});
});

describe("wizardCredentialState", () => {
	test("reports each slot satisfied by env, stored, or neither", () => {
		const state = wizardCredentialState(
			{ ANTHROPIC_API_KEY: "sk", WARREN_GIT_TOKEN: "t" },
			{ WARREN_GIT_AUTHOR_NAME: "octo", WARREN_GIT_AUTHOR_EMAIL: "o@x" },
		);
		expect(state).toEqual({ model: true, github: true, author: true });
		expect(wizardCredentialState({}, {})).toEqual({ model: false, github: false, author: false });
	});
});

describe("runUpWizard", () => {
	test("bypasses every prompt when stdin is not a TTY and still returns the stored env", async () => {
		const home = freshHome();
		writeWizardEnv(wizardEnvPath(home), { WARREN_GIT_TOKEN: "ghp_stored" });
		const { context, out } = captureContext();
		let prompted = false;
		const result = await runUpWizard(
			context,
			wizardDeps(home, {
				isInteractive: () => false,
				prompt: async () => {
					prompted = true;
					return "x";
				},
			}),
			{ wizard: true },
		);
		expect(prompted).toBe(false);
		expect(result).toEqual({ WARREN_GIT_TOKEN: "ghp_stored" });
		expect(out.join("")).not.toContain("saved credentials");
	});

	test("bypasses prompts under --no-wizard even on a TTY", async () => {
		const home = freshHome();
		let prompted = false;
		const { context } = captureContext();
		const result = await runUpWizard(
			context,
			wizardDeps(home, {
				prompt: async () => {
					prompted = true;
					return "x";
				},
			}),
			{ wizard: false },
		);
		expect(prompted).toBe(false);
		expect(result).toEqual({});
	});

	test("skips prompts when the env already carries the credential (env beats stored and prompt)", async () => {
		const home = freshHome();
		writeWizardEnv(wizardEnvPath(home), { WARREN_GIT_TOKEN: "ghp_stored" });
		const { context } = captureContext({ ANTHROPIC_API_KEY: "sk-env", GITHUB_TOKEN: "gh-env" });
		const result = await runUpWizard(context, wizardDeps(home), { wizard: true });
		// Stored GitHub token still returns for the under-env merge, but no
		// prompt ran (deps.prompt throws) and nothing new was written.
		expect(result).toEqual({ WARREN_GIT_TOKEN: "ghp_stored" });
	});

	test("captures a Claude subscription token via claude setup-token and states the harness limit", async () => {
		const home = freshHome();
		const { context, out } = captureContext();
		const result = await runUpWizard(
			context,
			wizardDeps(home, {
				hasBinary: (name) => name === "claude",
				runCommand: async (cmd) =>
					cmd.join(" ") === "claude setup-token"
						? { stdout: "sk-ant-oat-captured\n", exitCode: 0 }
						: { stdout: "", exitCode: 1 },
				prompt: async () => "",
			}),
			{ wizard: true },
		);
		expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-captured");
		expect(loadWizardEnv(wizardEnvPath(home))).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-captured",
		});
		const text = out.join("");
		expect(text).toContain("ONLY the claude-code harness");
		expect(text).toContain("mode 0600");
		// The token value itself never reaches the output.
		expect(text).not.toContain("sk-ant-oat-captured");
	});

	test("falls back to a pasted CLAUDE_CODE_OAUTH_TOKEN when the claude CLI is absent", async () => {
		const home = freshHome();
		const { context, out } = captureContext();
		const result = await runUpWizard(
			context,
			wizardDeps(home, {
				prompt: async (q) => (q.includes("Claude subscription") ? "y" : "sk-ant-oat-pasted"),
			}),
			{ wizard: true },
		);
		expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-pasted");
		expect(out.join("")).toContain("npm i -g @anthropic-ai/claude-code");
	});

	test("declining the subscription accepts a pasted ANTHROPIC_API_KEY", async () => {
		const home = freshHome();
		const { context } = captureContext();
		const result = await runUpWizard(
			context,
			wizardDeps(home, {
				prompt: async (q) => (q.includes("Claude subscription") ? "n" : "sk-ant-api-pasted"),
			}),
			{ wizard: true },
		);
		expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-api-pasted");
	});

	test("reuses a detected gh token, showing the account, and defaults the git author from /user", async () => {
		const home = freshHome();
		const { context, out } = captureContext();
		const result = await runUpWizard(
			context,
			wizardDeps(home, {
				hasBinary: (name) => name === "gh",
				runCommand: async (cmd) => {
					const line = cmd.join(" ");
					if (line === "gh auth token") return { stdout: "ghp_detected\n", exitCode: 0 };
					if (line === "gh api user --jq .login") return { stdout: "octocat\n", exitCode: 0 };
					return { stdout: "", exitCode: 1 };
				},
				prompt: async () => "",
				fetchGitHubLogin: async (token) => {
					expect(token).toBe("ghp_detected");
					return { login: "octocat", id: 123 };
				},
			}),
			{ wizard: true },
		);
		expect(result.WARREN_GIT_TOKEN).toBe("ghp_detected");
		expect(result.WARREN_GIT_AUTHOR_NAME).toBe("octocat");
		expect(result.WARREN_GIT_AUTHOR_EMAIL).toBe("123+octocat@users.noreply.github.com");
		const text = out.join("");
		expect(text).toContain("account octocat");
		expect(text).toContain("123+octocat@users.noreply.github.com");
		expect(text).toContain("GitHub App flow");
		expect(text).not.toContain("ghp_detected");
	});

	test("skips the git-author default when WARREN_GIT_AUTHOR_* is already set", async () => {
		const home = freshHome();
		const { context } = captureContext({
			WARREN_GIT_AUTHOR_NAME: "bot",
			WARREN_GIT_AUTHOR_EMAIL: "bot@x",
		});
		let fetched = false;
		const result = await runUpWizard(
			context,
			wizardDeps(home, {
				hasBinary: (name) => name === "gh",
				runCommand: async (cmd) =>
					cmd.join(" ") === "gh auth token"
						? { stdout: "ghp_detected\n", exitCode: 0 }
						: { stdout: "", exitCode: 1 },
				prompt: async () => "",
				fetchGitHubLogin: async () => {
					fetched = true;
					return { login: "octocat", id: 123 };
				},
			}),
			{ wizard: true },
		);
		expect(fetched).toBe(false);
		expect(result.WARREN_GIT_AUTHOR_NAME).toBeUndefined();
		expect(result.WARREN_GIT_TOKEN).toBe("ghp_detected");
	});

	test("merges new values over the existing store without losing old keys", async () => {
		const home = freshHome();
		writeWizardEnv(wizardEnvPath(home), { CLAUDE_CODE_OAUTH_TOKEN: "oat-old" });
		const { context } = captureContext();
		const result = await runUpWizard(
			context,
			wizardDeps(home, { prompt: async (q) => (q.includes("GitHub token") ? "ghp_new" : "") }),
			{ wizard: true },
		);
		expect(result).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oat-old", WARREN_GIT_TOKEN: "ghp_new" });
		expect(loadWizardEnv(wizardEnvPath(home))).toEqual(result);
	});

	test("writes nothing when every prompt is skipped", async () => {
		const home = freshHome();
		const { context, out } = captureContext();
		const result = await runUpWizard(context, wizardDeps(home, { prompt: async () => "" }), {
			wizard: true,
		});
		expect(result).toEqual({});
		// loadWizardEnv on the absent path stays empty — no file written.
		expect(loadWizardEnv(wizardEnvPath(home))).toEqual({});
		expect(out.join("")).not.toContain("saved credentials");
	});
});

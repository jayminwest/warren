/**
 * The `warren up` credential wizard (warren-80e9, pl-26f3 step 4).
 *
 * On a machine with no model or GitHub credential — none in the real
 * environment and none in the persisted store — `warren up` walks the
 * operator to a working credential set interactively, before boot:
 *
 *   1. Model credential: Claude subscription via `claude setup-token`
 *      (when the `claude` CLI is on PATH) or a pasted
 *      `CLAUDE_CODE_OAUTH_TOKEN`, or a pasted `ANTHROPIC_API_KEY`.
 *      Honesty constraint (plan pl-26f3 risk 2): the wizard states
 *      plainly that subscription auth serves ONLY the claude-code
 *      harness; pi and other providers still need their own API keys.
 *   2. GitHub credential: reuse a detected `gh auth token` (the account
 *      name is shown) or paste one. Framed as a bootstrap — the GitHub
 *      App flow (warren-b504) is the durable path.
 *   3. Git author identity: when a GitHub token was collected this
 *      session and `WARREN_GIT_AUTHOR_*` is unset, default
 *      name/email from the token's `GET /user` login
 *      (`<login>` / `<id>+<login>@users.noreply.github.com`).
 *
 * Accepted values persist to `~/.warren/env` (mode 0600, dir 0700) —
 * never into the repo, never into `client.json` (decision D5), never
 * into logs (the wizard prints key names, never values).
 *
 * Precedence everywhere: real env vars > stored file > prompt. The
 * wizard only prompts for a credential absent from BOTH env and store,
 * and `warren up --no-wizard` (or a non-TTY stdin: CI, scripts) skips
 * every prompt while still loading the stored file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { EnvLike } from "../../client/config.ts";
import { fetchGitHubUserLogin } from "../../forge/user-lookup.ts";
import type { CliContext } from "../output.ts";
import { binaryOnPath } from "./up.ts";

/** Where the wizard's env file lives under the warren home. */
export function wizardEnvPath(home: string): string {
	return join(home, ".warren", "env");
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Parse the wizard env file: one `KEY=VALUE` per line, `#` comments,
 * blank lines skipped. Malformed lines are skipped silently — the file
 * is warren-owned, and one bad line must not cost the operator every
 * stored credential.
 */
export function parseWizardEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (key === "" || value === "") continue;
		out[key] = value;
	}
	return out;
}

/** Load the wizard env file, or `{}` when absent. */
export function loadWizardEnv(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	return parseWizardEnv(readFileSync(path, "utf8"));
}

/**
 * Write `values` (a full merged record) to the wizard env file. The
 * directory is created 0700 and the file is written 0600 (and chmod'd,
 * so a pre-existing wider mode tightens). Never logs values.
 */
export function writeWizardEnv(path: string, values: Record<string, string>): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	const lines: string[] = [
		"# warren credential store — written by `warren up`, mode 0600",
		"# real environment variables always win over this file",
	];
	for (const key of Object.keys(values).sort()) {
		lines.push(`${key}=${values[key]}`);
	}
	writeFileSync(path, `${lines.join("\n")}\n`, { mode: FILE_MODE });
	chmodSync(path, FILE_MODE);
}

/** Is `key` set (non-blank) in `env` or `stored`? */
function credentialPresent(env: EnvLike, stored: Record<string, string>, key: string): boolean {
	for (const source of [env[key], stored[key]]) {
		if (source !== undefined && source.trim() !== "") return true;
	}
	return false;
}

/**
 * Merge wizard-stored values UNDER the real environment: env > stored.
 * Returns a fresh record; neither input is mutated.
 */
export function mergeUnderEnv(
	env: EnvLike,
	stored: Record<string, string>,
): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) merged[key] = value;
	for (const [key, value] of Object.entries(stored)) {
		if (merged[key] === undefined || merged[key].trim() === "") merged[key] = value;
	}
	return merged;
}

/** Which credential slots env+stored already satisfy. */
export function wizardCredentialState(
	env: EnvLike,
	stored: Record<string, string>,
): {
	readonly model: boolean;
	readonly github: boolean;
	readonly author: boolean;
} {
	return {
		model:
			credentialPresent(env, stored, "ANTHROPIC_API_KEY") ||
			credentialPresent(env, stored, "CLAUDE_CODE_OAUTH_TOKEN"),
		github:
			credentialPresent(env, stored, "WARREN_GIT_TOKEN") ||
			credentialPresent(env, stored, "GITHUB_TOKEN"),
		author:
			credentialPresent(env, stored, "WARREN_GIT_AUTHOR_NAME") &&
			credentialPresent(env, stored, "WARREN_GIT_AUTHOR_EMAIL"),
	};
}

/** Seams the wizard shells out through; injected in tests. */
export interface UpWizardDeps {
	readonly homeDir: () => string;
	/** True only when a human can answer prompts (TTY stdin). */
	readonly isInteractive: () => boolean;
	/** Ask one question, return the trimmed answer. */
	readonly prompt: (question: string) => Promise<string>;
	/** Run a short-lived command (claude / gh), capturing stdout. */
	readonly runCommand: (cmd: readonly string[]) => Promise<{ stdout: string; exitCode: number }>;
	/** Is a binary resolvable on PATH? */
	readonly hasBinary: (name: string) => boolean;
	/** One `GET /user` call behind the forge seam; fail-soft. */
	readonly fetchGitHubLogin: (token: string) => Promise<{ login: string; id: number } | undefined>;
}

const SETUP_TOKEN_TIMEOUT_MS = 120_000;

function defaultIsInteractive(): boolean {
	return process.stdin.isTTY === true;
}

async function defaultPrompt(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(question)).trim();
	} finally {
		rl.close();
	}
}

/** Production wizard deps: readline prompts, real PATH probes, the forge lookup. */
export function defaultUpWizardDeps(
	context: CliContext,
	env: EnvLike,
	homeDir: () => string,
): UpWizardDeps {
	return {
		homeDir,
		isInteractive: defaultIsInteractive,
		prompt: defaultPrompt,
		runCommand: async (cmd) =>
			context.spawn(cmd, { cwd: process.cwd(), timeoutMs: SETUP_TOKEN_TIMEOUT_MS }),
		hasBinary: (name) => binaryOnPath(name, env),
		fetchGitHubLogin: (token) => fetchGitHubUserLogin(token),
	};
}

function isAffirmative(answer: string): boolean {
	const a = answer.toLowerCase();
	return a === "" || a === "y" || a === "yes";
}

/**
 * Run the wizard. Returns the full set of stored+newly-collected env
 * additions for `warren up` to merge UNDER the real environment
 * (env > stored > prompted). Writes only when the operator supplied
 * new values.
 */
export async function runUpWizard(
	context: CliContext,
	deps: UpWizardDeps,
	opts: { readonly wizard: boolean },
): Promise<Record<string, string>> {
	const path = wizardEnvPath(deps.homeDir());
	const stored = loadWizardEnv(path);
	const updates: Record<string, string> = {};
	const out = context.stdio.stdout;

	// Non-interactive-safe: --no-wizard or a non-TTY stdin (CI, scripts)
	// loads the store and returns without a single prompt.
	if (opts.wizard && deps.isInteractive()) {
		const state = wizardCredentialState(context.env, stored);

		if (!state.model) {
			await promptModelCredential(context, deps, updates);
		}
		const githubToken = state.github ? undefined : await promptGithubToken(context, deps, updates);
		if (!state.author && githubToken !== undefined) {
			await defaultGitAuthor(context, deps, githubToken, updates);
		}
	}

	if (Object.keys(updates).length === 0) return stored;

	const next = { ...stored, ...updates };
	writeWizardEnv(path, next);
	out.write(
		`✔ saved credentials to ${path} (mode 0600) — next \`warren up\` needs no wizard\n` +
			"  stored keys: " +
			Object.keys(updates).sort().join(", ") +
			"\n",
	);
	return next;
}

/** Try the `claude setup-token` path, then a paste; undefined means skipped. */
async function captureSubscriptionToken(
	context: CliContext,
	deps: UpWizardDeps,
): Promise<string | undefined> {
	const out = context.stdio.stdout;
	if (deps.hasBinary("claude")) {
		out.write("Running `claude setup-token`…\n");
		const result = await deps.runCommand(["claude", "setup-token"]);
		const captured = result.stdout.trim();
		if (result.exitCode === 0 && captured !== "") return captured;
		out.write("`claude setup-token` did not return a token — falling back to a paste.\n");
	} else {
		out.write(
			"The `claude` CLI is not on PATH (install it with `npm i -g @anthropic-ai/claude-code`\n" +
				"for the guided flow), or paste a token now.\n",
		);
	}
	const pasted = (await deps.prompt("Paste CLAUDE_CODE_OAUTH_TOKEN (empty to skip): ")).trim();
	return pasted === "" ? undefined : pasted;
}

async function promptApiKey(deps: UpWizardDeps, updates: Record<string, string>): Promise<void> {
	const apiKey = (await deps.prompt("Paste ANTHROPIC_API_KEY (empty to skip): ")).trim();
	if (apiKey !== "") {
		updates.ANTHROPIC_API_KEY = apiKey;
	}
}

async function promptModelCredential(
	context: CliContext,
	deps: UpWizardDeps,
	updates: Record<string, string>,
): Promise<void> {
	const out = context.stdio.stdout;
	out.write(
		"\nNo model credential found (neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN).\n",
	);
	const answer = await deps.prompt("Use your Claude subscription? [Y/n] ");
	if (!isAffirmative(answer)) {
		await promptApiKey(deps, updates);
		return;
	}
	const token = await captureSubscriptionToken(context, deps);
	if (token === undefined) {
		out.write("Skipped the Claude subscription.\n");
		await promptApiKey(deps, updates);
		return;
	}
	updates.CLAUDE_CODE_OAUTH_TOKEN = token;
	out.write(
		"✔ captured a Claude subscription token.\n" +
			"  Note: subscription auth serves ONLY the claude-code harness.\n" +
			"  pi and other providers still need their own API keys.\n",
	);
}

/** Detected `gh auth token`, with the login shown when gh can name it. */
async function detectGhToken(context: CliContext, deps: UpWizardDeps): Promise<string | undefined> {
	if (!deps.hasBinary("gh")) return undefined;
	const result = await deps.runCommand(["gh", "auth", "token"]);
	const detected = result.exitCode === 0 ? result.stdout.trim() : "";
	if (detected === "") return undefined;
	let account = "";
	const who = await deps.runCommand(["gh", "api", "user", "--jq", ".login"]);
	if (who.exitCode === 0) account = who.stdout.trim();
	const label = account === "" ? "the logged-in account" : `account ${account}`;
	const answer = await deps.prompt(`Reuse the gh token for ${label}? [Y/n] `);
	if (!isAffirmative(answer)) return undefined;
	context.stdio.stdout.write(`✔ reusing the gh token for ${label}.\n`);
	return detected;
}

async function promptGithubToken(
	context: CliContext,
	deps: UpWizardDeps,
	updates: Record<string, string>,
): Promise<string | undefined> {
	const out = context.stdio.stdout;
	out.write(
		"\nNo GitHub token found (WARREN_GIT_TOKEN / GITHUB_TOKEN).\n" +
			"Heads-up: a pasted token is a bootstrap — the GitHub App flow is the durable path\n" +
			"(see the warren docs; the wizard works fine with neither).\n",
	);
	let token = await detectGhToken(context, deps);
	if (token === undefined) {
		const pasted = (await deps.prompt("Paste a GitHub token (empty to skip): ")).trim();
		if (pasted !== "") {
			token = pasted;
			out.write("✔ captured a GitHub token.\n");
		}
	}
	if (token === undefined) {
		out.write("Skipped the GitHub credential.\n");
		return undefined;
	}
	updates.WARREN_GIT_TOKEN = token;
	return token;
}

async function defaultGitAuthor(
	context: CliContext,
	deps: UpWizardDeps,
	token: string,
	updates: Record<string, string>,
): Promise<void> {
	const user = await deps.fetchGitHubLogin(token);
	if (user === undefined) {
		context.stdio.stdout.write(
			"Could not fetch the GitHub login for a git-author default — set\n" +
				"WARREN_GIT_AUTHOR_NAME / WARREN_GIT_AUTHOR_EMAIL to override manually.\n",
		);
		return;
	}
	updates.WARREN_GIT_AUTHOR_NAME = user.login;
	updates.WARREN_GIT_AUTHOR_EMAIL = `${user.id}+${user.login}@users.noreply.github.com`;
	context.stdio.stdout.write(
		`✔ git author identity: ${user.login} <${user.id}+${user.login}@users.noreply.github.com>\n` +
			"  (defaulted from the GitHub token; override with WARREN_GIT_AUTHOR_NAME / WARREN_GIT_AUTHOR_EMAIL)\n",
	);
}

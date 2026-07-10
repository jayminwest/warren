/**
 * Per-workspace git identity.
 *
 * Warren writes a workspace-local `.gitconfig.burrow` that the agent runtime
 * later consumes via `GIT_CONFIG_GLOBAL=<workspace>/.gitconfig.burrow`. Doing
 * it via a file (instead of `git config --worktree`) keeps the user's host
 * clone untouched — we never enable `extensions.worktreeConfig` or mutate the
 * shared `.git/config`, both of which would surprise the user across all of
 * their other worktrees.
 *
 * Extracted from burrow's `src/git/identity.ts` (k8s-migration §5.A) so the
 * module now lives in warren and serves both the Local and K8s providers.
 * Behavior is identical to burrow's; only the burrow-prefixed symbols were
 * renamed to neutral workspace-oriented names. The gitconfig filename value is
 * unchanged (`.gitconfig.burrow`) to preserve the runtime contract with the
 * agent-side consumer that sets `GIT_CONFIG_GLOBAL`.
 *
 * Two modes:
 *   - `user`  — read host `~/.gitconfig` (`user.name` / `user.email`) and
 *               mirror it into the workspace.
 *   - `bot`   — use a configured pair (e.g. "Acme Agents <bots@acme.example>").
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./exec.ts";

export const WORKSPACE_GITCONFIG_FILENAME = ".gitconfig.burrow";

export interface GitIdentity {
	name: string;
	email: string;
}

export type IdentitySpec =
	| { mode: "user" }
	| { mode: "bot"; name: string; email: string }
	| { mode: "explicit"; name: string; email: string };

export interface ResolveIdentityOptions {
	hostEnv?: Record<string, string | undefined>;
}

/**
 * Read the host's git identity by querying `git config user.name/email`.
 * Returns the pair only when both halves are present — partial host configs
 * are treated as missing so the workspace doesn't ship with a half-formed
 * committer line.
 */
export async function readHostGitIdentity(
	options: ResolveIdentityOptions = {},
): Promise<GitIdentity | null> {
	const env = options.hostEnv ?? process.env;
	const [name, email] = await Promise.all([
		readConfig("user.name", env),
		readConfig("user.email", env),
	]);
	if (!name || !email) return null;
	return { name, email };
}

export async function resolveWorkspaceIdentity(
	spec: IdentitySpec,
	options: ResolveIdentityOptions = {},
): Promise<GitIdentity | null> {
	switch (spec.mode) {
		case "user":
			return readHostGitIdentity(options);
		case "bot":
		case "explicit":
			return { name: spec.name, email: spec.email };
	}
}

/**
 * Render a minimal gitconfig, returning the file body. Keeping it explicit
 * (as opposed to invoking `git config --file ...`) lets us write atomically
 * and lets the caller diff or print the body for the user.
 */
export function renderWorkspaceGitconfig(identity: GitIdentity): string {
	return `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`;
}

export interface WriteWorkspaceGitconfigResult {
	configPath: string;
	identity: GitIdentity;
}

/**
 * Write `<workspace>/.gitconfig.burrow`. The agent runtime sets
 * `GIT_CONFIG_GLOBAL` to this path so git inside the sandbox picks up the
 * identity without any host-side mutation.
 */
export async function writeWorkspaceGitconfig(
	workspacePath: string,
	identity: GitIdentity,
): Promise<WriteWorkspaceGitconfigResult> {
	const configPath = join(workspacePath, WORKSPACE_GITCONFIG_FILENAME);
	await writeFile(configPath, renderWorkspaceGitconfig(identity), { mode: 0o600 });
	return { configPath, identity };
}

async function readConfig(
	key: string,
	hostEnv: Record<string, string | undefined>,
): Promise<string | null> {
	const res = await runGit(["config", "--get", key], { env: hostEnv });
	if (res.exitCode !== 0) return null;
	const value = res.stdout.trim();
	return value.length > 0 ? value : null;
}

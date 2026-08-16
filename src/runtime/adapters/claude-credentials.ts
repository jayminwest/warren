/**
 * claude-code host-credential forwarding — source-lifted from burrow's
 * `src/runtime/claude-code.ts` (warren-7933, plan pl-3007). Split out of
 * `./claude-code.ts` for the file-size budget.
 *
 * When the host is logged in (burrow SPEC §17.4), `prepareWorkspace`
 * forwards credentials into the run's `.claude/` so the sandboxed agent
 * finds them via HOME-relative lookup without requiring a second
 * `/login`. Source is platform-specific:
 *   - linux: copy `~/.claude/.credentials.json` if present.
 *   - darwin: extract from the macOS Keychain (service `Claude Code-
 *     credentials`) and materialize as `.credentials.json`. The sandbox
 *     denies Keychain IPC, so the file fallback is the only viable path.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Auth file Claude Code writes when it can't reach the OS keychain. */
const CLAUDE_CREDENTIALS_FILE = ".credentials.json";

/** macOS Keychain service name claude-code uses for OAuth tokens. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface ForwardCredentialsOptions {
	home?: string;
	plat?: NodeJS.Platform;
	/** Override for tests: returns the Keychain blob (or null if absent). */
	keychainReader?: KeychainReader;
}

/**
 * Read the Claude Code OAuth blob from the macOS Keychain. Returns `null`
 * when the entry is missing or the `security` shell-out is unavailable so
 * a fresh host (no login yet) is never a hard error.
 */
export type KeychainReader = (service: string) => Promise<string | null>;

export const macKeychainReader: KeychainReader = async (service) => {
	try {
		const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exit = await proc.exited;
		if (exit !== 0) return null;
		const out = (await new Response(proc.stdout).text()).trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
};

/**
 * Forward host credentials into the run's `.claude/`. Inside the sandbox
 * HOME is `/workspace`, so the agent reads `HOME/.claude/.credentials.json`
 * — materializing the file ahead of every spawn lets token refreshes pick
 * up on the next prompt. No-op when the host has never logged in.
 *
 * Linux: copy the host's `.credentials.json` byte-for-byte.
 * macOS: extract from the Keychain (service `Claude Code-credentials`) and
 * write the JSON blob into the workspace. The sandbox profile denies
 * Keychain IPC, so claude-code's file fallback is the only path that works.
 */
export async function forwardClaudeHostCredentials(
	workspacePath: string,
	options: ForwardCredentialsOptions = {},
): Promise<void> {
	const plat = options.plat ?? process.platform;
	const home = options.home ?? homedir();

	let body: string | null = null;
	if (plat === "darwin") {
		const reader = options.keychainReader ?? macKeychainReader;
		body = await reader(CLAUDE_KEYCHAIN_SERVICE);
	} else {
		const hostCreds = join(home, ".claude", CLAUDE_CREDENTIALS_FILE);
		if (existsSync(hostCreds)) {
			const claudeDir = join(workspacePath, ".claude");
			mkdirSync(claudeDir, { recursive: true });
			await copyFile(hostCreds, join(claudeDir, CLAUDE_CREDENTIALS_FILE));
		}
		return;
	}

	if (body === null) return;
	const claudeDir = join(workspacePath, ".claude");
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(claudeDir, CLAUDE_CREDENTIALS_FILE), body, {
		encoding: "utf8",
		flag: "w",
		mode: 0o600,
	});
}

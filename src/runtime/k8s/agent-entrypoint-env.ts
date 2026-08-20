/**
 * The env surface of the in-pod agent entrypoint (`./agent-entrypoint.ts`) —
 * the parsed `AgentEntrypointEnv` contract, the `WARREN_*` readers, and the
 * frontmatter parser. Split out of `./agent-entrypoint.ts` for the file-size
 * ratchet (warren-cb93); the entrypoint re-exports this surface so existing
 * import sites keep working. Everything here is pure.
 */

import type { AcceptedRuntimeId } from "../../core/wire.ts";
import { type AgentUidDrop, parseAgentUidDrop } from "./agent-uid-drop.ts";

export interface AgentEntrypointEnv {
	runId: string;
	runtimeId: AcceptedRuntimeId;
	prompt: string;
	workspacePath: string;
	/** Callback base URL (Service DNS) — inbox drain + finalize; absent ⇒ both skipped. */
	apiUrl: string | undefined;
	/** Bearer for the callback; absent ⇒ inbox drain + finalize skipped. */
	apiToken: string | undefined;
	/** Agent frontmatter (provider/model overrides the runtime honors), if any. */
	frontmatter: Record<string, unknown> | undefined;
	/** Poll interval for the steering-inbox drain (ms). */
	inboxPollIntervalMs: number;
	/**
	 * Grace (ms) between the stdin-hold idle watchdog's stdin close and its
	 * hard kill of the child (warren-9a4a). `0` kills immediately — mostly a
	 * test knob so the watchdog path doesn't cost 15s per case.
	 */
	stdinHoldKillGraceMs: number;
	/**
	 * Watchdog for stdin-held runtimes (pi): if the child produces no stdout for
	 * this many ms while stdin is still held open, warren closes stdin (nudging
	 * the runtime to exit on EOF) and force-kills as a backstop — so a hung
	 * inference can't pin the pod forever waiting on a close-trigger event that
	 * never arrives. `0` disables the watchdog. Runtimes that close stdin at
	 * spawn (claude-code) never arm it. (warren-7a43)
	 */
	stdinHoldIdleTimeoutMs: number;
	/**
	 * The uid/gid the AGENT process drops to via setpriv (warren-cb93,
	 * `./agent-uid-drop.ts`) — distinct from the entrypoint's uid so a forged
	 * write at `/proc/1/fd/1` from the agent fails EACCES. `undefined` spawns
	 * the agent unwrapped (standalone smoke runs; DockerProvider has no
	 * in-pod entrypoint at all).
	 */
	agentRunAs: AgentUidDrop | undefined;
}

export type AgentEnvSource = Readonly<Record<string, string | undefined>>;

function required(env: AgentEnvSource, key: string): string {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") {
		throw new Error(`agent-entrypoint: missing required env ${key}`);
	}
	return raw;
}

function optional(env: AgentEnvSource, key: string): string | undefined {
	const raw = env[key]?.trim();
	return raw === undefined || raw === "" ? undefined : raw;
}

function positiveIntEnv(env: AgentEnvSource, key: string, fallback: number): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Like `positiveIntEnv` but allows `0` (a knob's disable sentinel). */
function nonNegativeIntEnv(env: AgentEnvSource, key: string, fallback: number): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Parse the agent frontmatter carried on `WARREN_AGENT_METADATA` (the domain's
 * `composeBurrowMetadata` folds `{ frontmatter }` into the run metadata). A
 * malformed / non-object value yields `undefined` (the runtime falls back to its
 * pinned provider/model defaults) rather than failing the run.
 */
export function parseAgentFrontmatter(
	raw: string | undefined,
): Record<string, unknown> | undefined {
	if (raw === undefined || raw === "") return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const frontmatter = (value as { frontmatter?: unknown }).frontmatter;
		if (frontmatter !== null && typeof frontmatter === "object" && !Array.isArray(frontmatter)) {
			return frontmatter as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Default stdin-hold idle watchdog: 30 min. */
export const DEFAULT_STDIN_HOLD_IDLE_TIMEOUT_MS = 1_800_000;

/** Default grace between the watchdog's stdin close and its hard kill: 15s. */
export const DEFAULT_STDIN_HOLD_KILL_GRACE_MS = 15_000;

/** Parse + validate the agent entrypoint env. Pure. */
export function parseAgentEntrypointEnv(env: AgentEnvSource): AgentEntrypointEnv {
	const apiUrlRaw = optional(env, "WARREN_API_URL");
	return {
		runId: required(env, "WARREN_RUN_ID"),
		runtimeId: required(env, "WARREN_AGENT_RUNTIME"),
		prompt: env.WARREN_PROMPT ?? "",
		workspacePath: optional(env, "WARREN_WORKSPACE_PATH") ?? "/workspace",
		apiUrl: apiUrlRaw?.replace(/\/+$/, ""),
		apiToken: optional(env, "WARREN_API_TOKEN"),
		frontmatter: parseAgentFrontmatter(env.WARREN_AGENT_METADATA),
		inboxPollIntervalMs: positiveIntEnv(env, "WARREN_INBOX_POLL_INTERVAL_MS", 5_000),
		stdinHoldIdleTimeoutMs: nonNegativeIntEnv(
			env,
			"WARREN_AGENT_STDIN_HOLD_IDLE_MS",
			DEFAULT_STDIN_HOLD_IDLE_TIMEOUT_MS,
		),
		stdinHoldKillGraceMs: nonNegativeIntEnv(
			env,
			"WARREN_AGENT_STDIN_KILL_GRACE_MS",
			DEFAULT_STDIN_HOLD_KILL_GRACE_MS,
		),
		// warren-cb93: parseAgentUidDrop THROWS on a malformed value — fail
		// closed rather than silently run the agent at the entrypoint's uid.
		agentRunAs: parseAgentUidDrop(env),
	};
}

/**
 * Spawn-prep helpers for the host-side drive loop (warren-8a6e split from
 * `./drive.ts` to keep that file under the line-count budget). Owns runtime
 * resolution, restricted-network proxy arming, and the cancel-win settle path
 * LocalEngine.cancel races against.
 */

import {
	type ProxyHandle,
	proxyEnvVars,
	type StartProxyOptions,
	startProxy,
} from "../../sandbox/proxy-server.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import { forwardClaudeHostCredentials } from "../adapters/claude-credentials.ts";
import { type AgentRuntimeAdapter, allAdapters } from "../adapters/index.ts";
import type { AgentFrontmatter } from "../adapters/types.ts";
import type { RunSpec } from "../contract.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

/** Subset of DriveDeps this module needs — avoids a drive.ts circular import. */
export interface PrepareDeps {
	readonly startProxy?: (opts: StartProxyOptions) => Promise<ProxyHandle>;
	readonly registry?: { get(id: string): AgentRuntimeAdapter | undefined };
	readonly now?: () => Date;
}

function readSpecFrontmatter(
	metadata: Record<string, unknown> | undefined,
): AgentFrontmatter | undefined {
	const raw = metadata?.frontmatter;
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	return raw as AgentFrontmatter;
}

/** The default adapter registry: warren's built-in runtime adapters. */
export const DEFAULT_REGISTRY: { get(id: string): AgentRuntimeAdapter | undefined } = {
	get: (id) => allAdapters().find((adapter) => adapter.runtimeId === id),
};

/** Fail fast with a structured record when the runtime id is unknown or spawnless. */
export function failBeforeSpawn(
	store: LocalRunStore,
	record: LocalRunRecord,
	message: string,
	deps: PrepareDeps,
): void {
	const now = deps.now ?? (() => new Date());
	store.appendEvent(record, { kind: "error", stream: "system", payload: { message } }, now);
	store.terminalize(record, {
		phase: "failed",
		exitCode: null,
		terminalReason: "error",
		errorMessage: message,
	});
}

/** Settle cancelled if a cancel won; no-op when already terminal (warren-8a6e). */
export function settleCancelledIfNeeded(store: LocalRunStore, record: LocalRunRecord): void {
	if (store.isTerminal(record)) return;
	store.terminalize(record, {
		phase: "cancelled",
		exitCode: null,
		terminalReason: "cancelled",
		errorMessage: "cancelled",
	});
}

/** True when cancel latched or the record already carries a terminal phase. */
export function cancelWon(store: LocalRunStore, record: LocalRunRecord): boolean {
	return record.cancelRequested || store.isTerminal(record);
}

/**
 * Tear down a child that lost the cancel race before the pump loop. Best-effort
 * kill + drain; never rethrows (LocalEngine.cancel may already have killed it).
 */
export async function abandonSpawnedChild(
	store: LocalRunStore,
	record: LocalRunRecord,
	proc: SpawnResult,
	proxy: ProxyHandle | null,
): Promise<void> {
	if (record.proc !== proc) {
		try {
			proc.cancel();
		} catch {
			/* already torn down */
		}
	}
	await proxy?.stop();
	await proc.exited.catch(() => 0);
	settleCancelledIfNeeded(store, record);
}

export interface PreparedSpawn {
	readonly runtime: AgentRuntimeAdapter;
	readonly runProfile: SandboxProfile;
	readonly runCommand: SpawnCommand;
	readonly proxy: ProxyHandle | null;
	readonly useStdinHold: boolean;
}

/** Resolve runtime + command + optional restricted-network proxy, or null on fail. */
export async function prepareSpawn(
	store: LocalRunStore,
	record: LocalRunRecord,
	spec: RunSpec,
	profile: SandboxProfile,
	deps: PrepareDeps,
): Promise<PreparedSpawn | null> {
	const runtime = (deps.registry ?? DEFAULT_REGISTRY).get(spec.runtimeId);
	if (runtime === undefined) {
		failBeforeSpawn(store, record, `runtime '${spec.runtimeId}' is not registered`, deps);
		return null;
	}
	if (runtime.buildSpawnCommand === undefined) {
		failBeforeSpawn(
			store,
			record,
			`runtime '${spec.runtimeId}' declares no buildSpawnCommand`,
			deps,
		);
		return null;
	}

	const pendingMessages = store.claimPending(record, deps.now);
	if (runtime.prepareWorkspace !== undefined) {
		await runtime.prepareWorkspace({ runId: spec.runId, workspacePath: record.workspacePath });
	}
	// warren-c865: with $HOME a real per-run directory, forward the host's
	// claude OAuth blob into it so auth resolves via $HOME lookup.
	if (spec.runtimeId === "claude-code") {
		await forwardClaudeHostCredentials(record.homePath).catch(() => {});
	}

	const useStdinHold = typeof runtime.shouldCloseStdinOnEvent === "function";
	const frontmatter = readSpecFrontmatter(spec.metadata);
	const baseCommand = runtime.buildSpawnCommand({
		runId: spec.runId,
		prompt: spec.prompt,
		pendingMessages,
		workspacePath: record.workspacePath,
		...(frontmatter !== undefined ? { frontmatter } : {}),
	});
	const holdCommand: SpawnCommand = useStdinHold
		? { ...baseCommand, holdStdin: true }
		: baseCommand;

	// warren-70bb: under network=restricted, start a per-run loopback CONNECT
	// proxy that enforces allowedDomains and overlays HTTP(S)_PROXY.
	const armed = await armRestrictedProxy(store, record, profile, holdCommand, deps);
	if (armed === null) return null;
	return {
		runtime,
		runProfile: armed.runProfile,
		runCommand: armed.runCommand,
		proxy: armed.proxy,
		useStdinHold,
	};
}

interface ArmedProxy {
	readonly runProfile: SandboxProfile;
	readonly runCommand: SpawnCommand;
	readonly proxy: ProxyHandle | null;
}

/**
 * When `profile.network === "restricted"`, start the per-run proxy and return
 * a profile+command pair with `proxyAddress` + HTTP(S)_PROXY set. On start
 * failure the run is terminalized failed and `null` is returned so the caller
 * bails without spawning. open/none return the inputs unchanged with no proxy.
 */
async function armRestrictedProxy(
	store: LocalRunStore,
	record: LocalRunRecord,
	profile: SandboxProfile,
	command: SpawnCommand,
	deps: PrepareDeps,
): Promise<ArmedProxy | null> {
	if (profile.network !== "restricted") {
		return { runProfile: profile, runCommand: command, proxy: null };
	}
	const startProxyFn = deps.startProxy ?? startProxy;
	let proxy: ProxyHandle;
	try {
		proxy = await startProxyFn({ allowedDomains: profile.allowedDomains });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		failBeforeSpawn(store, record, `failed to start network proxy: ${message}`, deps);
		return null;
	}
	const runProfile: SandboxProfile = {
		...profile,
		proxyAddress: { host: "127.0.0.1", port: proxy.port },
	};
	const runCommand: SpawnCommand = {
		...command,
		env: {
			...(command.env ?? {}),
			...proxyEnvVars(proxy.url),
		},
	};
	return { runProfile, runCommand, proxy };
}

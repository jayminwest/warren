/**
 * Acceptance harness — burrow serve wrapper with the stub-shell agent
 * pre-registered in the runtime registry.
 *
 * `burrow serve` starts an HTTP server backed by `Client.open()` whose
 * AgentRegistry only carries the three built-in runtimes (claude-code,
 * sapling, codex). The acceptance harness needs a deterministic agent
 * with no API key dependency, so it ships its own `stub-shell` declared
 * via the project's `burrow.toml [[agents]]` block — but burrow doesn't
 * auto-register declarative configs from a project's burrow.toml at
 * serve time (the `[[agents]]` array there only patches built-in
 * toolchain mounts; runtime registration is intentionally an explicit
 * opt-in, see node_modules/@os-eco/burrow-cli/src/runtime/registry.ts).
 *
 * This wrapper closes that gap by:
 *   1. Opening the same `Client` `burrow serve` would have opened (env
 *      vars + paths flow through `Client.open()`).
 *   2. Registering `stub-shell` programmatically before any runs can
 *      dispatch.
 *   3. Calling `runServeCommand` with the same options the upstream CLI
 *      would have wired — so warren talks to a real burrow HTTP surface,
 *      not a mock.
 *
 * Lifecycle mirrors the burrow CLI: SIGINT/SIGTERM aborts the serve
 * loop, runServeCommand teardown closes the dispatcher + handle, then
 * Client.close() drops the SQLite handle. Used only by the acceptance
 * harness — production warren talks to `burrow serve` directly.
 */
import { Client, type DispatchSpawnFn, loadAgentConfig } from "@os-eco/burrow-cli";
import { runServeCommand } from "@os-eco/burrow-cli/src/cli/commands/serve.ts";
import { parseJsonlClaude } from "@os-eco/burrow-cli/src/runtime/parsers/jsonl-claude.ts";
import { parsePiEvents } from "@os-eco/burrow-cli/src/runtime/parsers/pi.ts";
import type { AgentRuntime } from "@os-eco/burrow-cli/src/runtime/runtime.ts";

interface ParsedArgs {
	socket?: string;
	noAuth: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	const out: ParsedArgs = { noAuth: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--socket": {
				const next = argv[++i];
				if (next === undefined) throw new Error("--socket requires a path");
				out.socket = next;
				break;
			}
			case "--no-auth":
				out.noAuth = true;
				break;
			default:
				throw new Error(`burrow-with-stub: unknown flag ${JSON.stringify(arg)}`);
		}
	}
	return out;
}

/**
 * No-bwrap spawn used by the acceptance harness — the upstream
 * `runSandboxed` requires a host with CAP_SYS_ADMIN to set up a fresh
 * pid/mount namespace (`bwrap: Can't mount proc on /newroot/proc:
 * Operation not permitted`), and acceptance runs in regular dev/CI
 * containers where that capability isn't granted. The harness isn't
 * testing sandbox isolation; it's testing warren's HTTP contract on top
 * of a real burrow process pair, so spawning the agent directly via
 * Bun.spawn against the resolved workspace is enough.
 */
const noSandboxSpawn: DispatchSpawnFn = async (profile, command) => {
	const cwd = resolveCwd(profile.workspace, command.cwd);
	const wantsStdin = command.stdin !== undefined;
	const env: Record<string, string> = { ...profile.setEnv };
	for (const k of profile.envPassthrough) {
		const v = process.env[k];
		if (typeof v === "string") env[k] = v;
	}
	if (typeof process.env.PATH === "string") env.PATH = process.env.PATH;
	if (command.env !== undefined) Object.assign(env, command.env);

	const proc = Bun.spawn({
		cmd: command.argv,
		cwd,
		env,
		stdin: wantsStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (wantsStdin && typeof command.stdin === "string") {
		const writer = proc.stdin as unknown as { write?: (s: string) => void; end?: () => void };
		if (typeof writer.write === "function") writer.write(command.stdin);
		if (typeof writer.end === "function") writer.end();
	}

	let cancelled = false;
	const cancel = (): void => {
		if (cancelled) return;
		cancelled = true;
		try {
			proc.kill();
		} catch {
			// Already dead — caller still gets `exited`.
		}
	};

	return {
		pid: proc.pid ?? 0,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited: proc.exited.then((code) => code ?? 0),
		cancel,
	};
};

function resolveCwd(workspace: string, cwd: string | undefined): string {
	if (cwd === undefined || cwd.length === 0) return workspace;
	if (cwd.startsWith("/")) return cwd;
	return `${workspace}/${cwd}`;
}

const STUB_AGENT_CONFIG = {
	id: "stub-shell",
	displayName: "Stub Shell (acceptance)",
	command: "bash",
	args: ["./tools/stub-agent.sh", "{{prompt}}"],
	promptDelivery: "arg" as const,
	outputFormat: "raw-text" as const,
	supportsResume: false,
	inboxDelivery: "none" as const,
};

// Pi (`@earendil-works/pi-coding-agent`) is the third built-in coding-agent
// runtime warren ships (alongside claude-code + sapling). Burrow's piRuntime
// is the cross-repo half of pl-4374 (warren-0e06) and is not yet shipped in
// @os-eco/burrow-cli; until it lands, the acceptance harness registers a
// custom AgentRuntime for the `pi` id (warren-17a4):
//
//   - dispatch via the standard declarative spawn renderer pointing at
//     `tools/pi-stub-agent.sh` (emits pi RPC JSONL with `turn_end` usage)
//   - parseEvents replaced with burrow's real `parsePiEvents` so the
//     stub's lines flow through warren's bridge as `state_change`
//     events whose payload carries the pi envelope verbatim
//
// This bypasses burrow's declarative `outputFormat` enum (which only
// supports raw-text / stream-json / jsonl-claude — see burrow
// src/schemas/agent-config.ts) without widening the cross-repo surface.
// Same id ('pi') warren forwards as the burrow runtime id at burrow.up
// time (mx-7352f4).
const PI_AGENT_CONFIG = {
	id: "pi",
	displayName: "Pi Coding Agent (acceptance stub)",
	command: "bash",
	args: ["./tools/pi-stub-agent.sh", "{{prompt}}"],
	promptDelivery: "arg" as const,
	// outputFormat must satisfy the AgentConfig schema for loadAgentConfig;
	// we override parseEvents below before registering, so the parser
	// chosen here (raw-text) is never invoked.
	outputFormat: "raw-text" as const,
	supportsResume: false,
	inboxDelivery: "none" as const,
};

/**
 * Build the custom pi runtime: declarative spawn machinery + pi parser.
 * loadAgentConfig validates+materializes an AgentRuntime; we shallow-copy
 * it and replace parseEvents with parsePiEvents. Keeping the rest of the
 * runtime intact (buildSpawnCommand, prepareWorkspace, installCheck, etc.)
 * means the dispatch path is identical to the declarative one — only
 * the event taxonomy changes.
 */
function buildPiAcceptanceRuntime(): AgentRuntime {
	const base = loadAgentConfig(PI_AGENT_CONFIG);
	return {
		...base,
		parseEvents: (line: string) => parsePiEvents(line),
	};
}

// Claude-code stub (warren-87f9). Burrow ships a built-in `claude-code`
// runtime that invokes the real `claude` CLI — which the acceptance
// harness can't drive without an Anthropic API key. We register a
// custom AgentRuntime under the same id, which `Map.set` semantics in
// AgentRegistry (burrow `src/runtime/registry.ts`) overrides cleanly.
// The stub script emits stream-json with a terminal `result` envelope
// carrying `total_cost_usd` + `usage.*_tokens`; warren's bridge
// (src/runs/stream.ts:extractClaudeUsage) reads it on terminal
// detection. Scenario 17 asserts the resulting cost/token columns are
// non-null.
const CLAUDE_AGENT_CONFIG = {
	id: "claude-code",
	displayName: "Claude Code (acceptance stub)",
	command: "bash",
	args: ["./tools/claude-code-stub-agent.sh", "{{prompt}}"],
	promptDelivery: "arg" as const,
	// outputFormat must satisfy the AgentConfig schema; the real parser
	// is swapped in below via parseEvents override.
	outputFormat: "raw-text" as const,
	supportsResume: false,
	inboxDelivery: "none" as const,
};

function buildClaudeAcceptanceRuntime(): AgentRuntime {
	const base = loadAgentConfig(CLAUDE_AGENT_CONFIG);
	return {
		...base,
		parseEvents: (line: string) => parseJsonlClaude(line),
	};
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));

	const ac = new AbortController();
	const onSig = (): void => ac.abort();
	process.on("SIGINT", onSig);
	process.on("SIGTERM", onSig);

	const client = await Client.open();
	try {
		// Register the declarative stub agent so the dispatcher can resolve
		// `agentId: "stub-shell"` when warren spawns a run. Identical to what
		// `burrow.toml [[agents]]` *would* do if upstream auto-registered it.
		client.agents.register(loadAgentConfig(STUB_AGENT_CONFIG));
		// Pi: same declarative dispatch + the real parsePiEvents parser
		// so `turn_end` usage envelopes reach warren's bridge (warren-17a4).
		client.agents.register(buildPiAcceptanceRuntime());
		// Override burrow's built-in claude-code runtime with a stub so
		// acceptance scenarios can dispatch agent='claude-code' without an
		// Anthropic API key (warren-87f9).
		client.agents.register(buildClaudeAcceptanceRuntime());

		const serveOpts: Parameters<typeof runServeCommand>[0]["options"] = {};
		if (args.socket !== undefined) serveOpts.socket = args.socket;
		if (args.noAuth) serveOpts.noAuth = true;

		await runServeCommand({
			client,
			options: serveOpts,
			signal: ac.signal,
			stdout: process.stdout,
			dispatcherOptions: { spawn: noSandboxSpawn },
		});
	} finally {
		process.off("SIGINT", onSig);
		process.off("SIGTERM", onSig);
		await client.close();
	}
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error("burrow-with-stub:", err instanceof Error ? err.message : String(err));
		process.exit(1);
	},
);

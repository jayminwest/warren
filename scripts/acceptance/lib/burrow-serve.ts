/**
 * Acceptance-harness boot shim for `burrow serve`.
 *
 * Why we don't shell out to the `burrow` CLI: burrow's `Client.open()` boots
 * with `BUILT_IN_RUNTIMES` (claude-code, sapling, codex). Declarative
 * `[[agents]]` entries in a project's `burrow.toml` are NOT auto-registered
 * with the runtime registry — they only feed toolchainPath/credentialPath
 * collection (see node_modules/@os-eco/burrow-cli/src/cli/commands/up.ts).
 * So when scenarios spawn the `stub-shell` agent declared in our fixture's
 * burrow.toml, the dispatcher fails the run with
 * `agent 'stub-shell' is not registered` and the `run started` log line is
 * the only event burrow ever emits — which scenario 04 tolerates (it only
 * reads run.state from the POST /runs body before the dispatcher fires)
 * but scenarios 05/06 need actual stdout events to flow.
 *
 * This shim opens a Client, registers `stub-shell` programmatically via
 * `loadAgentConfig`, then forwards to `runServeCommand` with the same
 * arguments the CLI would. The harness execs us instead of `burrow serve`.
 *
 * Args: `--socket <path>` is required; `--no-auth` is forwarded as-is.
 * Anything else is rejected — the harness has only ever needed this pair,
 * keeping the shim's surface deliberately tight.
 */

import type { DispatchSpawnFn, DispatchStartProxyFn, ProxyHandle } from "@os-eco/burrow-cli";
import { Client, loadAgentConfig } from "@os-eco/burrow-cli";
import { runServeCommand } from "@os-eco/burrow-cli/src/cli/commands/serve.ts";

const STUB_AGENT_CONFIG = {
	id: "stub-shell",
	displayName: "Stub Shell (acceptance)",
	command: "bash",
	args: ["./tools/stub-agent.sh", "{{prompt}}"],
	promptDelivery: "arg",
	outputFormat: "raw-text",
	supportsResume: false,
	inboxDelivery: "none",
} as const;

interface ParsedArgs {
	socket: string;
	noAuth: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	let socket: string | undefined;
	let noAuth = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--socket": {
				const next = argv[++i];
				if (typeof next !== "string" || next.length === 0) {
					throw new Error("--socket requires a path argument");
				}
				socket = next;
				break;
			}
			case "--no-auth":
				noAuth = true;
				break;
			default:
				throw new Error(`unknown flag: ${JSON.stringify(arg)}`);
		}
	}
	if (socket === undefined) throw new Error("--socket is required");
	return { socket, noAuth };
}

/**
 * Bypass burrow's bwrap sandbox for harness runs. The acceptance harness
 * may be invoked from inside a nested userns (e.g. when an agent in
 * warren's own production sandbox runs the harness) where bwrap's
 * `setting up uid map: Permission denied` makes the standard sandboxed
 * spawn impossible. The contracts the scenarios verify (events table
 * durability, MAX(seq)+1 recovery, NDJSON envelope shape) are warren's
 * concern, not burrow's sandbox; running the agent unsandboxed against
 * the workspace is sufficient to drive them.
 *
 * Trade-off: we lose burrow's sandbox guarantees (network, fs scope) for
 * the duration of the run, but the stub agent only writes to the
 * workspace's relative `.mulch/` and `.seeds/` and emits stdout. Real
 * production warren still boots burrow's CLI directly, with bwrap
 * intact.
 */
const harnessSpawn: DispatchSpawnFn = async (profile, command) => {
	const cwd = command.cwd
		? command.cwd.startsWith("/")
			? command.cwd
			: `${profile.workspace}/${command.cwd}`
		: profile.workspace;
	const env: Record<string, string> = {
		...profile.setEnv,
		...(command.env ?? {}),
		HOME: profile.workspace,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
	};
	for (const name of profile.envPassthrough) {
		const value = process.env[name];
		if (typeof value === "string") env[name] = value;
	}
	const wantsStdin = command.stdin !== undefined;
	const proc = Bun.spawn(command.argv, {
		cwd,
		env,
		stdin: wantsStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (typeof command.stdin === "string" && proc.stdin && typeof proc.stdin !== "number") {
		proc.stdin.write(new TextEncoder().encode(command.stdin));
		await proc.stdin.end();
	}
	return {
		pid: proc.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited: proc.exited,
		cancel: () => proc.kill(),
	};
};

/** No-op proxy: scenarios use raw-text agents with no outbound HTTP. */
const harnessStartProxy: DispatchStartProxyFn = async () => {
	const handle: ProxyHandle = {
		port: 0,
		url: "http://127.0.0.1:0",
		deniedCount: 0,
		allowedCount: 0,
		stop: async () => undefined,
	};
	return handle;
};

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));

	const client = await Client.open();
	client.agents.register(loadAgentConfig(STUB_AGENT_CONFIG));

	const ac = new AbortController();
	const onSig = (): void => ac.abort();
	process.on("SIGINT", onSig);
	process.on("SIGTERM", onSig);

	try {
		await runServeCommand({
			client,
			options: { socket: args.socket, noAuth: args.noAuth },
			signal: ac.signal,
			stdout: process.stdout,
			dispatcherOptions: {
				spawn: harnessSpawn,
				startProxy: harnessStartProxy,
			},
		});
		return 0;
	} finally {
		process.off("SIGINT", onSig);
		process.off("SIGTERM", onSig);
		await client.close();
	}
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`burrow-serve shim: ${message}`);
		process.exit(1);
	},
);

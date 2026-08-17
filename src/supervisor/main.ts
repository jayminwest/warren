/**
 * Warren container entrypoint (docs/design/runtime-and-supervisor.md).
 *
 * warren-9a26 (plan pl-3007 phase 3): the burrow daemon is gone. The
 * spawn path is warren's own in-process engine (warren-413d), previews
 * ride the internalized sandbox (warren-4bf3), and the channel the
 * supervisor's token minting (warren-8071) served no longer exists. The
 * supervisor's sibling-process spawn, unix-socket wait poll, restart
 * budget, and token validation all died with the daemon.
 *
 * What remains is the single-process contract the orchestrator (Docker)
 * cannot own from outside the container:
 *
 *   1. Signal forwarding. SIGTERM/SIGINT to the container reaches warren
 *      with a 5s grace period, then SIGKILL if needed.
 *   2. Boot-time identity. The agent's git author identity is installed
 *      before warren spawns so the first dispatch can commit.
 *   3. Exit-code passthrough. Warren is the user-facing process; if it
 *      crashes, the supervisor exits with warren's code and hands the
 *      failure to the orchestrator's restart policy — never mask a
 *      warren bug with an in-process restart loop.
 *
 * Every external seam is injectable so the orchestrator can be unit-tested
 * without spawning real processes or installing real signal handlers.
 */

import { defaultGitIdentityRun, installGitAuthor } from "./git-identity.ts";

export interface SupervisedChild {
	readonly name: string;
	readonly pid: number | undefined;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
	readonly exited: Promise<number>;
}

export type SpawnFn = (cmd: readonly string[], name: "warren") => SupervisedChild;

export interface SupervisorLogger {
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
}

export type SignalName = "SIGTERM" | "SIGINT";
export type InstallSignalHandler = (signal: SignalName, handler: () => void) => () => void;

export interface SupervisorDeps {
	readonly spawn: SpawnFn;
	readonly installSignalHandler: InstallSignalHandler;
	readonly sleep: (ms: number) => Promise<void>;
	readonly logger: SupervisorLogger;
}

export interface SupervisorOpts {
	readonly warrenCmd: readonly string[];
	readonly signalGraceMs?: number;
}

export interface SupervisorResult {
	readonly exitCode: number;
	readonly reason: "warren_exited";
}

export const DEFAULT_SIGNAL_GRACE_MS = 5_000;

/**
 * Run the supervisor's lifecycle. Resolves when warren has terminated —
 * whether on its own or after a forwarded shutdown signal — and never
 * resolves on its own otherwise.
 */
export async function runSupervisor(
	deps: SupervisorDeps,
	opts: SupervisorOpts,
): Promise<SupervisorResult> {
	const grace = opts.signalGraceMs ?? DEFAULT_SIGNAL_GRACE_MS;

	const warren = deps.spawn(opts.warrenCmd, "warren");
	deps.logger.info({ pid: warren.pid, cmd: opts.warrenCmd }, "supervisor: spawned warren");

	let shuttingDown = false;
	let warrenExited = false;
	const onSignal = (signal: SignalName): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		deps.logger.info({ signal }, "supervisor: received shutdown signal, forwarding to warren");
		warren.kill("SIGTERM");
		// Arm the grace timer only now — a healthy warren must never race
		// it. Fire-and-forget: the main flow below awaits the real exit.
		void deps.sleep(grace).then(() => {
			if (warrenExited) return;
			deps.logger.warn(
				{ pid: warren.pid },
				"supervisor: warren did not exit within grace, sending SIGKILL",
			);
			warren.kill("SIGKILL");
		});
	};
	const uninstallTerm = deps.installSignalHandler("SIGTERM", () => onSignal("SIGTERM"));
	const uninstallInt = deps.installSignalHandler("SIGINT", () => onSignal("SIGINT"));

	try {
		const code = await warren.exited;
		warrenExited = true;
		deps.logger.info({ exitCode: code }, "supervisor: warren exited");
		return { exitCode: code, reason: "warren_exited" };
	} finally {
		uninstallTerm();
		uninstallInt();
	}
}

// ---------------------------------------------------------------------------
// Production wiring — Bun.spawn, real signal handlers.
// Tests bypass all of this by calling `runSupervisor` with their own deps.
// ---------------------------------------------------------------------------

export interface ProductionDepsOptions {
	readonly logger: SupervisorLogger;
}

export function productionDeps(options: ProductionDepsOptions): SupervisorDeps {
	return {
		spawn: defaultSpawn,
		installSignalHandler: defaultInstallSignalHandler,
		sleep: defaultSleep,
		logger: options.logger,
	};
}

const defaultSpawn: SpawnFn = (cmd, name) => {
	const proc = Bun.spawn({
		cmd: [...cmd],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		name,
		pid: proc.pid,
		kill: (signal) => {
			try {
				proc.kill(signal);
			} catch {
				// Killing a dead process is fine — we may have raced its exit.
			}
		},
		exited: proc.exited.then((code) => code ?? 0),
	};
};

const defaultInstallSignalHandler: InstallSignalHandler = (signal, handler) => {
	process.on(signal, handler);
	return () => {
		process.off(signal, handler);
	};
};

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CLI entry: `bun run src/supervisor/main.ts`. The Dockerfile / docker-compose
// ENTRYPOINT points here.
// ---------------------------------------------------------------------------

export interface ResolveCommandOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedCommand {
	readonly warrenCmd: readonly string[];
}

/**
 * Resolve the supervisor's launch command from env. The default matches the
 * canonical container layout (docs/design/runtime-and-supervisor.md); the env
 * overrides exist so a developer can point the supervisor at a different bun
 * binary or server entry on a host.
 *
 * Env contract:
 *   WARREN_SUPERVISOR_BUN  bun binary on PATH for spawning warren.
 *                          Default: "bun".
 *   WARREN_SERVER_ENTRY    path to warren's server entry. Default:
 *                          "src/server/main/index.ts".
 */
export function resolveCommandFromEnv(opts: ResolveCommandOptions = {}): ResolvedCommand {
	const env = opts.env ?? process.env;
	const bunBin = env.WARREN_SUPERVISOR_BUN ?? "bun";
	const serverEntry = env.WARREN_SERVER_ENTRY ?? "src/server/main/index.ts";
	return {
		warrenCmd: [bunBin, "run", serverEntry],
	};
}

if (import.meta.main) {
	const { default: pino } = await import("pino");
	const { LOG_REDACT_OPTIONS } = await import("../observability/log-redact.ts");
	const logger = pino({
		name: "warren-supervisor",
		level: process.env.WARREN_LOG_LEVEL ?? "info",
		redact: LOG_REDACT_OPTIONS,
	});
	const cmd = resolveCommandFromEnv();
	try {
		await installGitAuthor(
			{ run: defaultGitIdentityRun, logger },
			{
				authorName: process.env.WARREN_GIT_AUTHOR_NAME,
				authorEmail: process.env.WARREN_GIT_AUTHOR_EMAIL,
				gitBinary: process.env.WARREN_GIT_BINARY,
			},
		);
	} catch (err) {
		logger.error(
			{ err: err instanceof Error ? err.message : String(err) },
			"supervisor: failed to install git identity",
		);
		process.exit(1);
	}
	runSupervisor(productionDeps({ logger }), {
		warrenCmd: cmd.warrenCmd,
	})
		.then((result) => {
			logger.info({ exitCode: result.exitCode, reason: result.reason }, "supervisor exiting");
			process.exit(result.exitCode);
		})
		.catch((err) => {
			logger.error({ err: err instanceof Error ? err.message : String(err) }, "supervisor crashed");
			process.exit(1);
		});
}

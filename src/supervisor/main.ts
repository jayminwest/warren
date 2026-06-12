/**
 * Warren container entrypoint (SPEC §10.3).
 *
 * The supervisor runs as the docker / fly entrypoint and owns three
 * responsibilities the warren and burrow processes can't own themselves:
 *
 *   1. Boot ordering. `burrow serve` must open its unix socket before
 *      `warren` boots, otherwise warren's startup probe logs a noisy
 *      warning and `/readyz` flaps until the next refresh.
 *   2. Signal forwarding. SIGTERM/SIGINT to the container should reach
 *      both children with a 5s grace period, then SIGKILL if needed.
 *   3. Restart policy. Warren is the user-facing process; if it crashes,
 *      hand the failure to docker/fly so its restart policy decides what
 *      to do — never mask a warren bug with an in-process restart loop.
 *      Burrow is the runtime substrate; restart it inside the container
 *      with an exponential backoff and a 5-in-60s budget so a misbehaving
 *      burrow doesn't put the supervisor into a tight loop. After the
 *      budget is exhausted, exit non-zero so the orchestrator restarts
 *      the whole container.
 *
 * Every external seam is injectable so the orchestrator can be unit-tested
 * without spawning real processes or installing real signal handlers.
 */

import { backoffMs, RestartBudget } from "./budget.ts";
import { defaultGitCredentialsRun, installGitCredentials } from "./git-credentials.ts";
import { defaultGitIdentityRun, installGitAuthor } from "./git-identity.ts";
import { waitForSocket } from "./socket.ts";
import { TokenValidationError, validateBurrowAuthTokens } from "./tokens.ts";

export interface SupervisedChild {
	readonly name: string;
	readonly pid: number | undefined;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
	readonly exited: Promise<number>;
}

export type SpawnFn = (cmd: readonly string[], name: "burrow" | "warren") => SupervisedChild;

export interface SupervisorLogger {
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
}

export type SignalName = "SIGTERM" | "SIGINT";
export type InstallSignalHandler = (signal: SignalName, handler: () => void) => () => void;

export interface SupervisorDeps {
	readonly spawn: SpawnFn;
	readonly waitForSocket: (path: string) => Promise<boolean>;
	readonly installSignalHandler: InstallSignalHandler;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
	readonly logger: SupervisorLogger;
}

export interface SupervisorOpts {
	readonly socketPath: string;
	readonly burrowCmd: readonly string[];
	readonly warrenCmd: readonly string[];
	readonly signalGraceMs?: number;
	readonly burrowRestartBudget?: number;
	readonly burrowRestartWindowMs?: number;
	readonly burrowBackoffBaseMs?: number;
	readonly burrowBackoffCapMs?: number;
}

export interface SupervisorResult {
	readonly exitCode: number;
	readonly reason:
		| "warren_exited"
		| "socket_timeout"
		| "burrow_budget_exhausted"
		| "burrow_clean_exit";
}

export const DEFAULT_SIGNAL_GRACE_MS = 5_000;
export const DEFAULT_BURROW_RESTART_BUDGET = 5;
export const DEFAULT_BURROW_RESTART_WINDOW_MS = 60_000;

/**
 * Run the supervisor's lifecycle. Resolves when the orchestrator decides to
 * exit (warren has terminated, burrow's restart budget exhausted, or socket
 * never appeared); never resolves on its own otherwise.
 */
export async function runSupervisor(
	deps: SupervisorDeps,
	opts: SupervisorOpts,
): Promise<SupervisorResult> {
	const grace = opts.signalGraceMs ?? DEFAULT_SIGNAL_GRACE_MS;
	const budget = new RestartBudget(
		opts.burrowRestartBudget ?? DEFAULT_BURROW_RESTART_BUDGET,
		opts.burrowRestartWindowMs ?? DEFAULT_BURROW_RESTART_WINDOW_MS,
	);
	const baseBackoff = opts.burrowBackoffBaseMs ?? 1_000;
	const capBackoff = opts.burrowBackoffCapMs ?? 16_000;

	const state: SupervisorState = {
		shuttingDown: false,
		burrow: undefined,
		warren: undefined,
	};

	state.burrow = deps.spawn(opts.burrowCmd, "burrow");
	deps.logger.info({ pid: state.burrow.pid, cmd: opts.burrowCmd }, "supervisor: spawned burrow");

	const socketReady = await deps.waitForSocket(opts.socketPath);
	if (!socketReady) {
		deps.logger.error(
			{ socketPath: opts.socketPath },
			"supervisor: burrow socket did not appear before timeout",
		);
		state.shuttingDown = true;
		await terminateChild(state.burrow, deps, grace);
		return { exitCode: 1, reason: "socket_timeout" };
	}

	state.warren = deps.spawn(opts.warrenCmd, "warren");
	deps.logger.info({ pid: state.warren.pid, cmd: opts.warrenCmd }, "supervisor: spawned warren");

	const onSignal = (signal: SignalName) => {
		if (state.shuttingDown) return;
		state.shuttingDown = true;
		deps.logger.info({ signal }, "supervisor: received shutdown signal, forwarding to children");
		state.warren?.kill("SIGTERM");
		state.burrow?.kill("SIGTERM");
	};
	const uninstallTerm = deps.installSignalHandler("SIGTERM", () => onSignal("SIGTERM"));
	const uninstallInt = deps.installSignalHandler("SIGINT", () => onSignal("SIGINT"));

	try {
		const burrowSupervisor = superviseBurrow(state, deps, opts, budget, baseBackoff, capBackoff);
		const warrenWatcher = state.warren.exited.then((code) => ({ kind: "warren" as const, code }));

		const outcome = await Promise.race([
			warrenWatcher,
			burrowSupervisor.then((reason) => ({ kind: "burrow" as const, reason })),
		]);

		if (outcome.kind === "warren") {
			deps.logger.info(
				{ exitCode: outcome.code },
				"supervisor: warren exited, tearing down burrow",
			);
			state.shuttingDown = true;
			await terminateChild(state.burrow, deps, grace);
			return { exitCode: outcome.code, reason: "warren_exited" };
		}

		// Burrow gave up. Tear down warren so docker/fly's restart policy
		// brings the whole container back fresh.
		deps.logger.error({ reason: outcome.reason }, "supervisor: burrow oversight ended");
		state.shuttingDown = true;
		state.warren?.kill("SIGTERM");
		const warrenExitWithGrace = await raceWithGrace(state.warren.exited, grace, deps);
		if (warrenExitWithGrace === "timeout") state.warren?.kill("SIGKILL");
		return { exitCode: 1, reason: outcome.reason };
	} finally {
		uninstallTerm();
		uninstallInt();
	}
}

interface SupervisorState {
	shuttingDown: boolean;
	burrow: SupervisedChild | undefined;
	warren: SupervisedChild | undefined;
}

/**
 * Watches burrow and restarts it on non-zero exit. Resolves when the
 * supervisor must give up — budget exhausted, an unexpected clean exit,
 * or a shutdown is in progress (in which case the resolver is the warren
 * watcher's race winner anyway).
 */
async function superviseBurrow(
	state: SupervisorState,
	deps: SupervisorDeps,
	opts: SupervisorOpts,
	budget: RestartBudget,
	baseBackoff: number,
	capBackoff: number,
): Promise<"burrow_budget_exhausted" | "burrow_clean_exit"> {
	let attempt = 0;
	while (true) {
		const child = state.burrow;
		if (child === undefined) {
			// Should not happen: caller spawns burrow before entering this loop.
			return "burrow_clean_exit";
		}
		const exitCode = await child.exited;
		if (state.shuttingDown) {
			// Graceful shutdown is owned by the outer loop — let the warren
			// watcher decide the supervisor's exit code. Park here forever
			// so the Promise.race elsewhere wins.
			return new Promise<never>(() => undefined);
		}
		if (exitCode === 0) {
			deps.logger.error(
				{},
				"supervisor: burrow exited 0 without a shutdown signal — supervisor giving up",
			);
			return "burrow_clean_exit";
		}
		const tNow = deps.now();
		if (!budget.tryRecord(tNow)) {
			deps.logger.error(
				{
					recentCount: budget.recentCount(tNow),
					maxRestarts: budget.maxRestarts,
					windowMs: budget.windowMs,
				},
				"supervisor: burrow restart budget exhausted",
			);
			return "burrow_budget_exhausted";
		}
		attempt += 1;
		const wait = backoffMs(attempt, baseBackoff, capBackoff);
		deps.logger.warn(
			{ exitCode, attempt, waitMs: wait },
			"supervisor: burrow exited non-zero, restarting after backoff",
		);
		await deps.sleep(wait);
		if (state.shuttingDown) return new Promise<never>(() => undefined);
		state.burrow = deps.spawn(opts.burrowCmd, "burrow");
		deps.logger.info({ pid: state.burrow.pid, attempt }, "supervisor: spawned burrow (restart)");
		// Wait for the socket to come back. A failed re-acquisition does NOT
		// abort: the next iteration will catch the new burrow's exit and
		// either restart again or exhaust the budget.
		const ok = await deps.waitForSocket(opts.socketPath);
		if (!ok) {
			deps.logger.warn(
				{ socketPath: opts.socketPath, attempt },
				"supervisor: burrow socket did not reappear within timeout — continuing to watch exit",
			);
		}
	}
}

/**
 * Send SIGTERM, wait up to `graceMs`, then SIGKILL if the child is still alive.
 * Always awaits the child's actual exit so the supervisor doesn't return
 * before its children are cleaned up.
 */
async function terminateChild(
	child: SupervisedChild | undefined,
	deps: SupervisorDeps,
	graceMs: number,
): Promise<void> {
	if (child === undefined) return;
	child.kill("SIGTERM");
	const result = await raceWithGrace(child.exited, graceMs, deps);
	if (result === "timeout") {
		deps.logger.warn(
			{ name: child.name, pid: child.pid },
			"supervisor: child did not exit within grace, sending SIGKILL",
		);
		child.kill("SIGKILL");
		await child.exited;
	}
}

async function raceWithGrace(
	exitP: Promise<number>,
	graceMs: number,
	deps: SupervisorDeps,
): Promise<"exited" | "timeout"> {
	const result = await Promise.race([
		exitP.then(() => "exited" as const),
		deps.sleep(graceMs).then(() => "timeout" as const),
	]);
	return result;
}

// ---------------------------------------------------------------------------
// Production wiring — Bun.spawn, real signal handlers, real fs.access.
// Tests bypass all of this by calling `runSupervisor` with their own deps.
// ---------------------------------------------------------------------------

export interface ProductionDepsOptions {
	readonly logger: SupervisorLogger;
}

export function productionDeps(options: ProductionDepsOptions): SupervisorDeps {
	return {
		spawn: defaultSpawn,
		waitForSocket: (path) => waitForSocket(path),
		installSignalHandler: defaultInstallSignalHandler,
		sleep: defaultSleep,
		now: () => Date.now(),
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
	readonly socketPath: string;
	readonly burrowCmd: readonly string[];
	readonly warrenCmd: readonly string[];
}

export const DEFAULT_BURROW_SOCKET = "/var/run/burrow.sock";

/**
 * Resolve the supervisor's launch commands from env. The defaults match the
 * canonical container layout (SPEC §10.3); env overrides exist so a developer
 * can run the supervisor on a host without /var/run/.
 *
 * Env contract:
 *   WARREN_BURROW_SOCKET   socket the supervisor binds burrow to (and warren
 *                          reaches it through). Default: /var/run/burrow.sock
 *   WARREN_BURROW_BIN      burrow binary on PATH. Default: "burrow".
 *   WARREN_BURROW_NO_AUTH  1/true/yes/on (case-insensitive) appends --no-auth
 *                          to `burrow serve` so warren can boot on a
 *                          loopback-only dev box without BURROW_API_TOKEN.
 *                          Default: off.
 *   WARREN_BURROW_ARGS     extra whitespace-separated args appended to
 *                          `burrow serve` (after --no-auth, if any). Use for
 *                          flags warren doesn't yet model explicitly.
 *   WARREN_SUPERVISOR_BUN  bun binary on PATH for spawning warren.
 *                          Default: "bun".
 *   WARREN_SERVER_ENTRY    path to warren's server entry. Default:
 *                          "src/server/main/index.ts".
 */
export function resolveCommandFromEnv(opts: ResolveCommandOptions = {}): ResolvedCommand {
	const env = opts.env ?? process.env;
	const socketPath = env.WARREN_BURROW_SOCKET ?? DEFAULT_BURROW_SOCKET;
	const burrowBin = env.WARREN_BURROW_BIN ?? "burrow";
	const bunBin = env.WARREN_SUPERVISOR_BUN ?? "bun";
	const serverEntry = env.WARREN_SERVER_ENTRY ?? "src/server/main/index.ts";
	const burrowCmd: string[] = [burrowBin, "serve", "--socket", socketPath];
	if (parseBoolEnv(env.WARREN_BURROW_NO_AUTH)) burrowCmd.push("--no-auth");
	const extraArgs = parseArgsEnv(env.WARREN_BURROW_ARGS);
	if (extraArgs.length > 0) burrowCmd.push(...extraArgs);
	return {
		socketPath,
		burrowCmd,
		warrenCmd: [bunBin, "run", serverEntry],
	};
}

function parseBoolEnv(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const lower = raw.trim().toLowerCase();
	return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

function parseArgsEnv(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	const trimmed = raw.trim();
	if (trimmed === "") return [];
	return trimmed.split(/\s+/);
}

if (import.meta.main) {
	const { default: pino } = await import("pino");
	const logger = pino({
		name: "warren-supervisor",
		level: process.env.WARREN_LOG_LEVEL ?? "info",
	});
	const cmd = resolveCommandFromEnv();
	try {
		const noAuth = parseBoolEnv(process.env.WARREN_BURROW_NO_AUTH);
		const tokens = validateBurrowAuthTokens({
			burrowApiToken: process.env.BURROW_API_TOKEN,
			warrenBurrowToken: process.env.WARREN_BURROW_TOKEN,
			noAuth,
		});
		if (tokens.fingerprint === null) {
			logger.warn(
				{},
				"supervisor: WARREN_BURROW_NO_AUTH=1 — burrow will serve without auth (loopback-dev mode)",
			);
		} else {
			logger.info(
				{ fingerprint: tokens.fingerprint },
				"supervisor: burrow auth token validated (BURROW_API_TOKEN == WARREN_BURROW_TOKEN)",
			);
		}
	} catch (err) {
		if (err instanceof TokenValidationError) {
			logger.error(
				{ recoveryHint: err.recoveryHint },
				`supervisor: ${err.message} — refusing to spawn burrow + warren`,
			);
			process.exit(1);
		}
		logger.error(
			{ err: err instanceof Error ? err.message : String(err) },
			"supervisor: failed to validate burrow auth tokens",
		);
		process.exit(1);
	}
	try {
		await installGitCredentials(
			{ run: defaultGitCredentialsRun, logger },
			{
				githubToken: process.env.GITHUB_TOKEN,
				gitBinary: process.env.WARREN_GIT_BINARY,
			},
		);
	} catch (err) {
		logger.error(
			{ err: err instanceof Error ? err.message : String(err) },
			"supervisor: failed to install git insteadOf rule",
		);
		process.exit(1);
	}
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
		socketPath: cmd.socketPath,
		burrowCmd: cmd.burrowCmd,
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

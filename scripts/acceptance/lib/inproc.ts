/**
 * In-process boot for the acceptance harness.
 *
 * Boots a real `burrow serve` and a real `bun run src/server/main.ts`
 * as siblings on a temp dir. No docker, no compose. Used as the default
 * mode for fast/cheap acceptance runs; the `--container` flag flips to
 * compose-based booting (see `compose.ts`).
 *
 * Layout this creates under `${tmpRoot}`:
 *
 *   ├── data/
 *   │   ├── warren.db          ← created by warren on first connect
 *   │   ├── canopy-repo/        ← cloned by warren on POST /agents/refresh
 *   │   └── projects/           ← cloned by warren on POST /projects
 *   ├── burrow/                 ← burrow's own data dir
 *   ├── git-config              ← GIT_CONFIG_GLOBAL with insteadOf rewrites
 *   └── sock/burrow.sock        ← unix socket between warren and burrow
 *
 * Returns a `BootHandle` whose `stop()` SIGTERMs both processes and
 * cleans up the temp dir. The harness owns lifecycle; scenarios just
 * read the `warrenUrl` and `token` fields off the handle.
 *
 * Why we don't reuse warren's own `bootServer()` directly: the §10.3
 * supervisor is the deploy entrypoint, and the acceptance harness is
 * the closest in-process approximation we have to "what docker compose
 * up does." Boot here mirrors the supervisor's contract: spawn burrow
 * → wait for socket → spawn warren.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface InProcBootOptions {
	readonly tmpRoot: string;
	readonly token: string;
	readonly canopyRepoUrl: string;
	/** Path to a GIT_CONFIG_GLOBAL file (typically built by `buildFixtures`). */
	readonly gitConfigPath?: string;
	readonly bind?: { host: string; port: number };
	/** Additional env vars to pass through to warren / burrow. */
	readonly extraEnv?: Record<string, string>;
	/** Override the warren server entry; default `src/server/main.ts`. */
	readonly serverEntry?: string;
}

export interface BootHandle {
	readonly warrenUrl: string;
	readonly token: string;
	readonly tmpRoot: string;
	readonly socketPath: string;
	readonly dataDir: string;
	readonly env: Record<string, string>;
	stop(): Promise<void>;
	/** Force-stop only the warren process (leaves burrow up). For restart-recovery. */
	killWarren(): Promise<void>;
	/** Restart warren after a `killWarren()`. Burrow stays up across the restart. */
	restartWarren(): Promise<void>;
	/** Force-stop only burrow (for supervisor-restart-budget scenario). */
	killBurrow(): Promise<void>;
}

/**
 * Multi-burrow boot for the R-12 scenario (warren-82ea). Spawns N burrow
 * subprocesses each on its own unix socket inside `tmpRoot/sock/`,
 * writes a `warren.toml` with a `[[workers]]` row per burrow, and
 * spawns warren pointed at that toml via `WARREN_CONFIG_FILE`. Auth
 * runs end-to-end: every burrow is launched WITHOUT `--no-auth` and
 * WITH `BURROW_API_TOKEN=<shared>`, and warren reads the matching
 * `WARREN_BURROW_TOKEN` from env (the acceptance #8 contract in
 * src/server-config/workers.ts).
 *
 * Distinct from `bootInProc` to keep the single-burrow happy path
 * untouched — the existing scenarios 01-17 don't pay for the toml
 * write, the multi-process spawn loop, or the auth-on burrow.
 */
export interface MultiBurrowBootOptions {
	readonly tmpRoot: string;
	readonly token: string;
	readonly canopyRepoUrl: string;
	/** Per-worker name (becomes the `[[workers]]` row name + the worker dir). */
	readonly workers: readonly string[];
	readonly burrowToken: string;
	readonly gitConfigPath?: string;
	readonly bind?: { host: string; port: number };
	readonly extraEnv?: Record<string, string>;
	readonly serverEntry?: string;
}

export interface MultiBurrowHandle {
	readonly warrenUrl: string;
	readonly token: string;
	readonly tmpRoot: string;
	readonly dataDir: string;
	readonly env: Record<string, string>;
	readonly workers: ReadonlyArray<{ readonly name: string; readonly socketPath: string }>;
	stop(): Promise<void>;
	/** SIGKILL one of the burrow worker subprocesses by name. */
	killBurrow(name: string): Promise<void>;
}

const SOCKET_WAIT_TIMEOUT_MS = 5_000;
const HEALTHZ_WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

export async function bootInProc(opts: InProcBootOptions): Promise<BootHandle> {
	const tmpRoot = opts.tmpRoot;
	const dataDir = join(tmpRoot, "data");
	const burrowDir = join(tmpRoot, "burrow");
	const sockDir = join(tmpRoot, "sock");
	const socketPath = join(sockDir, "burrow.sock");
	const canopyDir = join(dataDir, "canopy-repo");
	const projectsDir = join(dataDir, "projects");
	const dbPath = join(dataDir, "warren.db");
	const gitConfigPath = opts.gitConfigPath ?? join(tmpRoot, "git-config");

	for (const d of [dataDir, burrowDir, sockDir, projectsDir]) {
		await mkdir(d, { recursive: true });
	}

	const bind = opts.bind ?? { host: "127.0.0.1", port: pickPort() };
	const warrenUrl = `http://${bind.host}:${bind.port}`;

	const env: Record<string, string> = {
		...filterEnv(process.env),
		WARREN_API_TOKEN: opts.token,
		WARREN_BIND_HOST: bind.host,
		WARREN_BIND_PORT: String(bind.port),
		WARREN_DB_PATH: dbPath,
		WARREN_DATA_DIR: dataDir,
		WARREN_CANOPY_DIR: canopyDir,
		WARREN_PROJECTS_DIR: projectsDir,
		WARREN_BURROW_SOCKET: socketPath,
		WARREN_DISABLE_UI: "1",
		WARREN_LOG_LEVEL: process.env.WARREN_ACCEPTANCE_LOG_LEVEL ?? "warn",
		CANOPY_REPO_URL: opts.canopyRepoUrl,
		BURROW_DATA_DIR: burrowDir,
		GIT_CONFIG_GLOBAL: gitConfigPath,
		// Empty per-process git identity so commits don't fail in CI.
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
		...(opts.extraEnv ?? {}),
	};

	if (opts.gitConfigPath === undefined) {
		// No [user] block (warren-9f70). Identity comes from the
		// GIT_AUTHOR_* / GIT_COMMITTER_* env vars set above; a global
		// [user] can leak into agent-side commits via the project
		// clone's .git/config under the wrong conditions.
		await writeFile(gitConfigPath, "[init]\n\tdefaultBranch = main\n");
	}

	const state: ProcState = {
		burrow: spawnBurrow(socketPath, env, burrowDir),
		warren: undefined,
		warrenStartCmd: () => spawnWarren(opts.serverEntry ?? "src/server/main.ts", env),
		warrenStopped: undefined,
	};

	await waitForSocket(socketPath, SOCKET_WAIT_TIMEOUT_MS);

	state.warren = state.warrenStartCmd();
	await waitForHealthz(warrenUrl, HEALTHZ_WAIT_TIMEOUT_MS);

	return {
		warrenUrl,
		token: opts.token,
		tmpRoot,
		socketPath,
		dataDir,
		env,
		stop: async () => {
			await stopChild(state.warren);
			state.warren = undefined;
			await stopChild(state.burrow);
			state.burrow = undefined;
			try {
				await rm(tmpRoot, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup — leftover temp dirs are noise, not bugs.
			}
		},
		killWarren: async () => {
			await stopChild(state.warren);
			state.warren = undefined;
		},
		restartWarren: async () => {
			if (state.warren !== undefined) return;
			state.warren = state.warrenStartCmd();
			await waitForHealthz(warrenUrl, HEALTHZ_WAIT_TIMEOUT_MS);
		},
		killBurrow: async () => {
			await stopChild(state.burrow);
			state.burrow = undefined;
		},
	};
}

interface SpawnedProc {
	readonly proc: ReturnType<typeof Bun.spawn>;
	readonly exited: Promise<number>;
}

interface ProcState {
	burrow: SpawnedProc | undefined;
	warren: SpawnedProc | undefined;
	warrenStartCmd: () => SpawnedProc;
	warrenStopped: Promise<void> | undefined;
}

function spawnBurrow(
	socketPath: string,
	env: Record<string, string>,
	burrowDataDir: string,
): SpawnedProc {
	// Acceptance burrow needs the declarative `stub-shell` agent registered
	// in its runtime registry — `burrow serve` doesn't auto-register agents
	// from a project's burrow.toml, so we launch a tiny wrapper that does
	// it programmatically before delegating to runServeCommand. Production
	// warren talks to plain `burrow serve` (the supervisor in src/supervisor/main.ts).
	const wrapperEntry = new URL("./burrow-with-stub.ts", import.meta.url).pathname;
	const proc = Bun.spawn({
		cmd: ["bun", "run", wrapperEntry, "--socket", socketPath, "--no-auth"],
		env: { ...env, BURROW_DATA_DIR: burrowDataDir },
		stdin: "ignore",
		stdout: process.env.WARREN_ACCEPTANCE_BURROW_STDOUT === "1" ? "inherit" : "ignore",
		stderr: process.env.WARREN_ACCEPTANCE_BURROW_STDERR === "1" ? "inherit" : "ignore",
	});
	return { proc, exited: proc.exited.then((c) => c ?? 0) };
}

function spawnWarren(serverEntry: string, env: Record<string, string>): SpawnedProc {
	const proc = Bun.spawn({
		cmd: ["bun", "run", serverEntry],
		env,
		stdin: "ignore",
		stdout: process.env.WARREN_ACCEPTANCE_WARREN_STDOUT === "1" ? "inherit" : "ignore",
		stderr: process.env.WARREN_ACCEPTANCE_WARREN_STDERR === "1" ? "inherit" : "ignore",
	});
	return { proc, exited: proc.exited.then((c) => c ?? 0) };
}

async function stopChild(child: SpawnedProc | undefined): Promise<void> {
	if (child === undefined) return;
	try {
		child.proc.kill("SIGTERM");
	} catch {
		// Already dead.
	}
	const result = await Promise.race([
		child.exited,
		new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
	]);
	if (result === "timeout") {
		try {
			child.proc.kill("SIGKILL");
		} catch {
			// Already dead.
		}
		await child.exited.catch(() => 0);
	}
}

export async function bootInProcMulti(opts: MultiBurrowBootOptions): Promise<MultiBurrowHandle> {
	if (opts.workers.length === 0) {
		throw new Error("bootInProcMulti: workers must be non-empty");
	}
	const tmpRoot = opts.tmpRoot;
	const dataDir = join(tmpRoot, "data");
	const sockDir = join(tmpRoot, "sock");
	const canopyDir = join(dataDir, "canopy-repo");
	const projectsDir = join(dataDir, "projects");
	const dbPath = join(dataDir, "warren.db");
	const gitConfigPath = opts.gitConfigPath ?? join(tmpRoot, "git-config");
	const tomlPath = join(tmpRoot, "warren.toml");

	for (const d of [dataDir, sockDir, projectsDir]) {
		await mkdir(d, { recursive: true });
	}

	const bind = opts.bind ?? { host: "127.0.0.1", port: pickPort() };
	const warrenUrl = `http://${bind.host}:${bind.port}`;

	// One data dir per worker so burrows don't trample one another's
	// sqlite db. Sockets live in a shared sockDir for easy operator-side
	// inspection.
	const workerLayout = opts.workers.map((name) => ({
		name,
		socketPath: join(sockDir, `${name}.sock`),
		burrowDataDir: join(tmpRoot, "burrow", name),
	}));
	for (const w of workerLayout) {
		await mkdir(w.burrowDataDir, { recursive: true });
	}

	// warren.toml: one `[[workers]]` row per burrow. The loader
	// (src/server-config/load.ts) reads this via WARREN_CONFIG_FILE; the
	// boot path branches to BurrowClientPool.fromConfig because
	// workers.length > 0.
	const tomlLines: string[] = [];
	for (const w of workerLayout) {
		tomlLines.push("[[workers]]");
		tomlLines.push(`name = "${w.name}"`);
		tomlLines.push(`url = "unix://${w.socketPath}"`);
		tomlLines.push("");
	}
	await writeFile(tomlPath, `${tomlLines.join("\n")}\n`);

	const sharedEnv: Record<string, string> = {
		...filterEnv(process.env),
		GIT_CONFIG_GLOBAL: gitConfigPath,
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};

	if (opts.gitConfigPath === undefined) {
		await writeFile(gitConfigPath, "[init]\n\tdefaultBranch = main\n");
	}

	const warrenEnv: Record<string, string> = {
		...sharedEnv,
		WARREN_API_TOKEN: opts.token,
		WARREN_BIND_HOST: bind.host,
		WARREN_BIND_PORT: String(bind.port),
		WARREN_DB_PATH: dbPath,
		WARREN_DATA_DIR: dataDir,
		WARREN_CANOPY_DIR: canopyDir,
		WARREN_PROJECTS_DIR: projectsDir,
		WARREN_DISABLE_UI: "1",
		WARREN_CONFIG_FILE: tomlPath,
		WARREN_BURROW_TOKEN: opts.burrowToken,
		// Faster probe so failover assertions don't have to wait the 30s
		// production default to see a killed worker flip to unreachable.
		WARREN_WORKER_PROBE_INTERVAL_MS: "500",
		WARREN_WORKER_PROBE_TIMEOUT_MS: "1000",
		WARREN_LOG_LEVEL: process.env.WARREN_ACCEPTANCE_LOG_LEVEL ?? "warn",
		CANOPY_REPO_URL: opts.canopyRepoUrl,
		...(opts.extraEnv ?? {}),
	};

	const burrows = new Map<string, SpawnedProc>();
	for (const w of workerLayout) {
		const burrowEnv: Record<string, string> = {
			...sharedEnv,
			BURROW_DATA_DIR: w.burrowDataDir,
			BURROW_API_TOKEN: opts.burrowToken,
		};
		burrows.set(w.name, spawnBurrowMulti(w.socketPath, burrowEnv));
	}

	for (const w of workerLayout) {
		await waitForSocket(w.socketPath, SOCKET_WAIT_TIMEOUT_MS);
	}

	const warren = spawnWarren(opts.serverEntry ?? "src/server/main.ts", warrenEnv);
	await waitForHealthz(warrenUrl, HEALTHZ_WAIT_TIMEOUT_MS);

	let warrenLive: SpawnedProc | undefined = warren;

	return {
		warrenUrl,
		token: opts.token,
		tmpRoot,
		dataDir,
		env: warrenEnv,
		workers: workerLayout.map((w) => ({ name: w.name, socketPath: w.socketPath })),
		stop: async () => {
			await stopChild(warrenLive);
			warrenLive = undefined;
			for (const [, b] of burrows) await stopChild(b);
			burrows.clear();
			try {
				await rm(tmpRoot, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup.
			}
		},
		killBurrow: async (name: string) => {
			const b = burrows.get(name);
			if (b === undefined) throw new Error(`bootInProcMulti.killBurrow: unknown worker ${name}`);
			// SIGKILL (not SIGTERM) so the scenario sees the unreachable
			// path rather than a clean shutdown; mirrors the R-12 promise that
			// a crashed worker doesn't take the fan-out down with it.
			try {
				b.proc.kill("SIGKILL");
			} catch {
				// Already dead.
			}
			await b.exited.catch(() => 0);
			burrows.delete(name);
		},
	};
}

function spawnBurrowMulti(socketPath: string, env: Record<string, string>): SpawnedProc {
	const wrapperEntry = new URL("./burrow-with-stub.ts", import.meta.url).pathname;
	// Auth ON: no `--no-auth`. Burrow reads BURROW_API_TOKEN from env and
	// requires every HTTP call to carry `Authorization: Bearer <token>`;
	// warren's BurrowClientPool.fromConfig threads the matching
	// WARREN_BURROW_TOKEN. This is the R-12 cross-host shape — no
	// implicit trust between warren and its workers.
	const proc = Bun.spawn({
		cmd: ["bun", "run", wrapperEntry, "--socket", socketPath],
		env,
		stdin: "ignore",
		stdout: process.env.WARREN_ACCEPTANCE_BURROW_STDOUT === "1" ? "inherit" : "ignore",
		stderr: process.env.WARREN_ACCEPTANCE_BURROW_STDERR === "1" ? "inherit" : "ignore",
	});
	return { proc, exited: proc.exited.then((c) => c ?? 0) };
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(path)) return;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`burrow socket did not appear at ${path} within ${timeoutMs}ms`);
}

async function waitForHealthz(baseUrl: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	let lastErr: string | undefined;
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${baseUrl}/healthz`, { method: "GET" });
			if (res.status === 200) return;
			lastErr = `status ${res.status}`;
		} catch (err) {
			lastErr = err instanceof Error ? err.message : String(err);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`warren /healthz did not respond 200 within ${timeoutMs}ms: ${lastErr ?? "unknown"}`,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickPort(): number {
	// 32_000–60_000 ephemeral range, randomized so parallel runs don't
	// trample. Real conflicts surface as boot timeouts, not silent fails.
	return 32_000 + Math.floor(Math.random() * 28_000);
}

const PASSTHROUGH_ENV_KEYS = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TZ",
]);

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		if (PASSTHROUGH_ENV_KEYS.has(k)) out[k] = v;
	}
	return out;
}

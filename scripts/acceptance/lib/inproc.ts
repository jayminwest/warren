/**
 * In-process boot for the acceptance harness.
 *
 * Boots a real `bun run src/server/main/index.ts` on a temp dir. No
 * docker, no compose, and — since the burrow absorption (warren-9a26 /
 * warren-ea0a) — no co-tenanted daemon: the local runtime is warren's
 * own in-process engine, so warren is the ONLY child process. Used as
 * the default mode for fast/cheap acceptance runs; the `--container`
 * flag flips to compose-based booting (see `compose.ts`).
 *
 * Layout this creates under `${tmpRoot}`:
 *
 *   ├── data/
 *   │   ├── warren.db          ← created by warren on first connect
 *   │   ├── canopy-repo/        ← cloned by warren on POST /agents/refresh
 *   │   └── projects/           ← cloned by warren on POST /projects
 *   └── git-config              ← GIT_CONFIG_GLOBAL with insteadOf rewrites
 *
 * Returns a `BootHandle` whose `stop()` SIGTERMs the process and cleans
 * up the temp dir. The harness owns lifecycle; scenarios just read the
 * `warrenUrl` and `token` fields off the handle.
 *
 * Why we don't reuse warren's own `bootServer()` directly: the
 * docs/design/runtime-and-supervisor.md supervisor is the deploy
 * entrypoint, and the acceptance harness is the closest in-process
 * approximation we have to "what docker compose up does."
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { waitForHealthz } from "./poll.ts";

export interface InProcBootOptions {
	readonly tmpRoot: string;
	readonly token: string;
	readonly canopyRepoUrl: string;
	/** Path to a GIT_CONFIG_GLOBAL file (typically built by `buildFixtures`). */
	readonly gitConfigPath?: string;
	readonly bind?: { host: string; port: number };
	/** Additional env vars to pass through to warren. */
	readonly extraEnv?: Record<string, string>;
	/** Override the warren server entry; default `src/server/main/index.ts`. */
	readonly serverEntry?: string;
	/**
	 * Override the WARREN_DB_URL contract (R-13). When set, the launcher
	 * passes `WARREN_DB_URL=<dbUrl>` and omits the legacy `WARREN_DB_PATH`
	 * so the server-config loader doesn't log a path↔url conflict warning.
	 * Used by scenario 19 (warren-480a) to point a per-scenario warren at
	 * an isolated Postgres database. Defaults to a sqlite file under
	 * `${tmpRoot}/data/warren.db` (today's behavior).
	 */
	readonly dbUrl?: string;
}

export interface BootHandle {
	readonly warrenUrl: string;
	readonly token: string;
	readonly tmpRoot: string;
	readonly dataDir: string;
	readonly env: Record<string, string>;
	stop(): Promise<void>;
	/** Force-stop only the warren process. For restart-recovery. */
	killWarren(): Promise<void>;
	/** Restart warren after a `killWarren()`. */
	restartWarren(): Promise<void>;
}

// 30s (warren-f074): 10s flaked on loaded CI runners booting the seeded
// second (public-mode) instance. waitForHealthz polls with backoff, so
// the happy path still resolves in the first few hundred ms locally.
const HEALTHZ_WAIT_TIMEOUT_MS = 30_000;

export async function bootInProc(opts: InProcBootOptions): Promise<BootHandle> {
	const tmpRoot = opts.tmpRoot;
	const dataDir = join(tmpRoot, "data");
	const canopyDir = join(dataDir, "canopy-repo");
	const projectsDir = join(dataDir, "projects");
	const dbPath = join(dataDir, "warren.db");
	const gitConfigPath = opts.gitConfigPath ?? join(tmpRoot, "git-config");

	for (const d of [dataDir, projectsDir]) {
		await mkdir(d, { recursive: true });
	}

	const bind = opts.bind ?? { host: "127.0.0.1", port: pickPort() };
	const warrenUrl = `http://${bind.host}:${bind.port}`;

	const useExplicitDbUrl = opts.dbUrl !== undefined && opts.dbUrl !== "";
	const env: Record<string, string> = {
		...filterEnv(process.env),
		WARREN_API_TOKEN: opts.token,
		WARREN_BIND_HOST: bind.host,
		WARREN_BIND_PORT: String(bind.port),
		// R-13 (warren-480a): when an explicit dbUrl is supplied (pg
		// scenarios), pass WARREN_DB_URL and omit WARREN_DB_PATH so the
		// loader doesn't fire its path↔url conflict warning. Otherwise
		// preserve today's WARREN_DB_PATH-only contract.
		...(useExplicitDbUrl ? { WARREN_DB_URL: opts.dbUrl as string } : { WARREN_DB_PATH: dbPath }),
		WARREN_DATA_DIR: dataDir,
		WARREN_CANOPY_DIR: canopyDir,
		WARREN_PROJECTS_DIR: projectsDir,
		WARREN_DISABLE_UI: "1",
		WARREN_LOG_LEVEL: process.env.WARREN_ACCEPTANCE_LOG_LEVEL ?? "warn",
		CANOPY_REPO_URL: opts.canopyRepoUrl,
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
		warren: undefined,
		warrenStartCmd: () => spawnWarren(opts.serverEntry ?? "src/server/main/index.ts", env),
	};

	state.warren = state.warrenStartCmd();
	await waitForHealthz(warrenUrl, HEALTHZ_WAIT_TIMEOUT_MS);

	return {
		warrenUrl,
		token: opts.token,
		tmpRoot,
		dataDir,
		env,
		stop: async () => {
			await stopChild(state.warren);
			state.warren = undefined;
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
	};
}

interface SpawnedProc {
	readonly proc: ReturnType<typeof Bun.spawn>;
	readonly exited: Promise<number>;
}

interface ProcState {
	warren: SpawnedProc | undefined;
	warrenStartCmd: () => SpawnedProc;
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

function pickPort(): number {
	// 32_000–60_000 ephemeral range, randomized so parallel runs don't
	// trample. Real conflicts surface as boot timeouts, not silent fails.
	return 32_000 + Math.floor(Math.random() * 28_000);
}

// Credential ownership (forge-contract.md §6.14, warren-2740): the harness
// itself owns no GitHub credential. `GITHUB_TOKEN`, when the operator exports
// it, is passed through and owned by the BOOTED warren — it funds warren's
// auto-open-PR config, the CI-fixer poller's check-runs fetch, and push auth.
// Per scenario:
//   - 35 (ci-fixer-roundtrip): the booted warren owns the token end-to-end;
//     the harness borrows it only for best-effort PR/branch cleanup
//     (lib/github.ts). Without it (and WARREN_ACCEPT_CI_FIXER_REPO) the
//     scenario records `skipped`, never a failure.
//   - 26 / 36 (plan-run scenarios): no real credential; they boot with
//     WARREN_FORGE=fake and drive merge transitions through the fake's
//     state file (lib/fake-forge.ts, warren-2600).
//   - 12 (supervisor-restart-budget): explicitly blanks GITHUB_TOKEN via
//     extraEnv to keep the dev-only insteadOf rewrite out of the assertion.
//   - everything else: auto-open-PR defaults on, but reap pr_open is
//     best-effort against the fake local-git fixtures (reap_failed is
//     tolerated), so an operator-exported token changes nothing observable.
const PASSTHROUGH_ENV_KEYS = new Set([
	// The booted warren owns the operator's GitHub credential (see the
	// credential-ownership note above). Without this entry an exported
	// GITHUB_TOKEN never reached the child env, so warren booted with an
	// empty auto-open-PR config and scenario 35's opener assertion could
	// not pass in in-proc mode (warren-2740).
	"GITHUB_TOKEN",
	// Seeds the stub-shell agent into every warren this harness boots
	// (warren-e376). run.ts points it at the fixture-built JSON file;
	// scenario-owned boots (20, 20-path, 26, 36) inherit it from
	// process.env so their private warren pairs register the stub too.
	"WARREN_SEED_AGENTS_FILE",
	// The stub-shell runtime id sits outside warren's canonical
	// KNOWN_RUNTIME_IDS, so the harness declares it as an operator
	// extension (warren-c4be). Without it, boot-time seeding refuses
	// the stub agent and every dispatch onto it fails 422.
	"WARREN_EXTRA_RUNTIME_IDS",
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

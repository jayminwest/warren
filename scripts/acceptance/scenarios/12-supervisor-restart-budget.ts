/**
 * Scenario 12 — supervisor restart-budget + tracked-run survival
 * (docs/design/runtime-and-supervisor.md, mx-c01c8a, mx-54c9ee).
 *
 * Acceptance criterion #12:
 *   "If burrow exits non-zero, the supervisor restarts it within the
 *   5-in-60s budget; warren stays up across the burrow restart and the
 *   warren-tracked run row created before the kill remains queryable."
 *
 * Why a separate process tree from the harness's bootInProc:
 *   The default in-proc launcher (lib/inproc.ts) spawns burrow + warren
 *   as siblings WITHOUT going through src/supervisor/main.ts — that's
 *   the right shape for scenarios 01-11 (faster, no signal-forwarding
 *   layer to debug). Scenario 12 is the one place the supervisor's
 *   restart loop is the system under test, so we boot a second,
 *   isolated supervisor instance under ${ctx.tmp}/scenario-12 with its
 *   own port, socket, db, and BURROW_DATA_DIR.
 *
 * Pid-file trick:
 *   The supervisor exposes the burrow command via WARREN_BURROW_BIN.
 *   We point it at a small bash shim that writes its pid (which becomes
 *   the spawned bun runtime via `exec`) to WARREN_ACCEPTANCE_BURROW_PID_FILE
 *   before delegating to scripts/acceptance/lib/burrow-with-stub.ts.
 *   That gives the scenario a portable way to find the burrow pid (no
 *   `lsof -U` / `fuser` — macOS dev hosts don't ship them) and to detect
 *   the supervisor's restart by polling for a pid value that differs
 *   from the original.
 *
 * Flow:
 *   1. Spawn supervisor → wait for warren /healthz.
 *   2. POST /projects + POST /runs (long sleep
 *      via WARREN_STUB_SLEEP_MS) so warren has a tracked run row that
 *      depends on burrow being alive.
 *   3. Read burrow pid_1 from pid file.
 *   4. SIGKILL pid_1 — supervisor's superviseBurrow() should hit the
 *      non-zero exit branch, consult the budget, sleep ~1s backoff,
 *      and respawn.
 *   5. Poll the pid file for pid_2 != pid_1; assert it appears in
 *      under RESTART_TIMEOUT_MS.
 *   6. Verify warren /healthz still 200 and GET /runs/:id still
 *      returns the row (state may be running or have errored from
 *      the bridge dropping; either is fine — the row survival is
 *      the assertion).
 *   7. Best-effort POST /runs/:id/cancel, then SIGTERM the supervisor.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { pollAcceptance, waitForHealthz } from "../lib/poll.ts";

const PORT_RANGE_START = 32_000;
const PORT_RANGE_SPAN = 28_000;
const SUPERVISOR_HEALTHZ_TIMEOUT_MS = 20_000;
const PID_FILE_INITIAL_TIMEOUT_MS = 10_000;
const RESTART_TIMEOUT_MS = 15_000;
const TEARDOWN_TIMEOUT_MS = 5_000;
const STUB_SLEEP_MS = 30_000; // long enough to outlast the kill+restart window

interface ProjectRow {
	readonly id: string;
}

interface CreateRunResponse {
	readonly run: {
		readonly id: string;
		readonly state: string;
	};
}

interface RunRow {
	readonly id: string;
	readonly state: string;
}

export const scenario: Scenario = {
	id: "12",
	title: "supervisor restarts burrow within budget; warren tracked run row survives the restart",
	modes: ["in-proc"],
	async run(ctx) {
		const scratch = join(ctx.tmp, "scenario-12");
		await mkdir(scratch, { recursive: true });
		const dataDir = join(scratch, "data");
		const burrowDataDir = join(scratch, "burrow-data");
		const projectsDir = join(scratch, "projects");
		const canopyDir = join(scratch, "canopy");
		await mkdir(dataDir, { recursive: true });
		await mkdir(burrowDataDir, { recursive: true });
		await mkdir(projectsDir, { recursive: true });
		const dbPath = join(dataDir, "warren.db");
		// macOS unix socket paths are capped at ~104 chars; keep this short.
		const socketPath = join(scratch, "b.sock");
		const pidFile = join(scratch, "burrow.pid");
		const shimPath = await writeBurrowShim(scratch);

		const port = pickPort();
		const warrenUrl = `http://127.0.0.1:${port}`;
		const token = randomToken();
		const wrapperPath = fileURLToPath(new URL("../lib/burrow-with-stub.ts", import.meta.url));
		const repoRoot = process.cwd();

		const env = buildSupervisorEnv({
			parentEnv: process.env,
			token,
			port,
			dbPath,
			dataDir,
			projectsDir,
			canopyDir,
			burrowDataDir,
			socketPath,
			shimPath,
			wrapperPath,
			pidFile,
			gitConfigPath: join(ctx.tmp, "git-config"),
			canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
		});

		ctx.logger.debug(`scenario-12: booting supervisor on ${warrenUrl} (sock=${socketPath})`);

		let supervisor: ReturnType<typeof Bun.spawn> | undefined;
		try {
			supervisor = Bun.spawn({
				cmd: ["bun", "run", "src/supervisor/main.ts"],
				cwd: repoRoot,
				env,
				stdin: "ignore",
				stdout: process.env.WARREN_ACCEPTANCE_SUP12_STDOUT === "1" ? "inherit" : "ignore",
				stderr: process.env.WARREN_ACCEPTANCE_SUP12_STDERR === "1" ? "inherit" : "ignore",
			});

			await waitForHealthz(warrenUrl, SUPERVISOR_HEALTHZ_TIMEOUT_MS);
			ctx.logger.debug("scenario-12: supervisor warren healthy");

			const http = new WarrenHttp({ baseUrl: warrenUrl, token });

			// stub-shell is seeded at boot (WARREN_SEED_AGENTS_FILE passed
			// through buildSupervisorEnv above) — no registry refresh call
			// exists anymore (warren-e376).
			const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);
			ctx.logger.debug(`scenario-12: project=${project.id}`);

			const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
				body: {
					agent: ctx.fixtures.stubAgentName,
					project: project.id,
					prompt: `[sleep_ms=${STUB_SLEEP_MS}] scenario-12 supervisor restart`,
				},
			});
			const runId = created.run.id;
			ctx.logger.debug(`scenario-12: created run ${runId}`);

			// Read burrow pid_1. The shim writes the pid synchronously before
			// exec'ing the wrapper, so it should be present by the time
			// /healthz returned 200, but allow a small window.
			const pid1 = await readPid(pidFile, PID_FILE_INITIAL_TIMEOUT_MS);
			assertTrue(
				Number.isInteger(pid1) && pid1 > 0,
				`burrow pid file must contain a positive integer; got ${pid1}`,
			);
			const pid1Mtime = await mtimeMs(pidFile);
			ctx.logger.debug(`scenario-12: burrow pid_1=${pid1}`);

			// Force-kill burrow. The supervisor's superviseBurrow() loop
			// catches exitCode != 0, records against the 5/60s budget, and
			// re-spawns after a 1s backoff.
			process.kill(pid1, "SIGKILL");
			ctx.logger.debug("scenario-12: SIGKILL'd burrow pid_1");

			// Poll for the pid file to update with a different pid.
			const pid2 = await waitForNewPid(pidFile, pid1, pid1Mtime, RESTART_TIMEOUT_MS);
			ctx.logger.debug(`scenario-12: burrow restarted, pid_2=${pid2}`);
			assertTrue(
				pid2 !== pid1,
				`supervisor must spawn a fresh burrow pid; pid_2=${pid2} matches pid_1=${pid1}`,
			);
			assertTrue(isProcessAlive(pid2), `pid_2=${pid2} must be alive after restart`);

			// Warren is still up — the supervisor never restarted it
			// (mx-e61d83: warren exit propagates; burrow exit triggers
			// restart). /healthz tolerates a brief window of bridge churn.
			await waitForHealthz(warrenUrl, 5_000);

			// The pre-kill run row survives the burrow restart. State may be
			// 'running' or terminal-failed (the bridge dropped on burrow's
			// death) — both shapes prove warren's persistence layer didn't
			// drop the row.
			const reread = await http.expectJson<RunRow>(
				"GET",
				`/runs/${encodeURIComponent(runId)}`,
				200,
			);
			assertEqual(reread.id, runId, "tracked run row id matches after burrow restart");
			ctx.logger.debug(`scenario-12: post-restart run state=${reread.state}`);

			// Best-effort cancel so teardown doesn't fight a 30s sleeper.
			try {
				await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
			} catch (err) {
				ctx.logger.debug(
					`scenario-12: cancel best-effort failure (${err instanceof Error ? err.message : String(err)})`,
				);
			}
		} finally {
			if (supervisor !== undefined) {
				try {
					supervisor.kill("SIGTERM");
				} catch {
					// already dead
				}
				const exit = await Promise.race([
					supervisor.exited,
					new Promise<"timeout">((resolve) =>
						setTimeout(() => resolve("timeout"), TEARDOWN_TIMEOUT_MS),
					),
				]);
				if (exit === "timeout") {
					try {
						supervisor.kill("SIGKILL");
					} catch {
						// already dead
					}
					await supervisor.exited.catch(() => 0);
				}
			}
			await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		}
	},
};

interface SupervisorEnvOpts {
	readonly parentEnv: NodeJS.ProcessEnv;
	readonly token: string;
	readonly port: number;
	readonly dbPath: string;
	readonly dataDir: string;
	readonly projectsDir: string;
	readonly canopyDir: string;
	readonly burrowDataDir: string;
	readonly socketPath: string;
	readonly shimPath: string;
	readonly wrapperPath: string;
	readonly pidFile: string;
	readonly gitConfigPath: string;
	readonly canopyRepoUrl: string;
}

function buildSupervisorEnv(opts: SupervisorEnvOpts): Record<string, string> {
	const passthrough: Record<string, string> = {};
	for (const k of [
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
		// Boot-time stub-agent seeding (warren-e376) — the supervisor's
		// warren child inherits its env, so passing the var through here
		// registers stub-shell before POST /runs.
		"WARREN_SEED_AGENTS_FILE",
		// Declares the harness's stub-shell burrow runtime id (warren-c4be).
		"WARREN_EXTRA_RUNTIME_IDS",
	]) {
		const v = opts.parentEnv[k];
		if (typeof v === "string") passthrough[k] = v;
	}
	return {
		...passthrough,
		WARREN_API_TOKEN: opts.token,
		// Bun auto-loads .env from cwd into spawned children. Explicitly
		// null out the dev-only knobs (GITHUB_TOKEN triggers the supervisor's
		// git-credentials writer which would clobber the fixture's
		// GIT_CONFIG_GLOBAL insteadOf rules; the burrow tokens collide with
		// WARREN_BURROW_NO_AUTH=1's loopback shape; ANTHROPIC_API_KEY is
		// irrelevant to the stub agent and shouldn't leak).
		GITHUB_TOKEN: "",
		BURROW_API_TOKEN: "",
		WARREN_BURROW_TOKEN: "",
		ANTHROPIC_API_KEY: "",
		WARREN_BIND_HOST: "127.0.0.1",
		WARREN_BIND_PORT: String(opts.port),
		WARREN_DB_PATH: opts.dbPath,
		WARREN_DATA_DIR: opts.dataDir,
		WARREN_PROJECTS_DIR: opts.projectsDir,
		WARREN_CANOPY_DIR: opts.canopyDir,
		WARREN_BURROW_SOCKET: opts.socketPath,
		WARREN_BURROW_BIN: opts.shimPath,
		WARREN_BURROW_NO_AUTH: "1",
		WARREN_SERVER_ENTRY: "src/server/main/index.ts",
		WARREN_SUPERVISOR_BUN: "bun",
		WARREN_DISABLE_UI: "1",
		WARREN_LOG_LEVEL: opts.parentEnv.WARREN_ACCEPTANCE_LOG_LEVEL ?? "warn",
		BURROW_DATA_DIR: opts.burrowDataDir,
		CANOPY_REPO_URL: opts.canopyRepoUrl,
		GIT_CONFIG_GLOBAL: opts.gitConfigPath,
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
		// Sample project's burrow.toml [env].optional forwards this into the
		// sandbox so the stub agent's `[sleep_ms=...]` knob outlasts the
		// kill+restart window (mx-8d39f5).
		WARREN_STUB_SLEEP_MS: String(STUB_SLEEP_MS),
		// Surfaced by the burrow shim — gives the scenario a portable way
		// to discover the burrow pid across restarts.
		WARREN_ACCEPTANCE_BURROW_PID_FILE: opts.pidFile,
		WARREN_ACCEPTANCE_BURROW_WRAPPER: opts.wrapperPath,
	};
}

async function writeBurrowShim(scratchDir: string): Promise<string> {
	// `bash` shim — the supervisor invokes `[shim, 'serve', '--socket', X,
	// '--no-auth']`. We strip the leading 'serve' (burrow-with-stub.ts
	// doesn't accept it) and write our own pid (which becomes bun's pid
	// after `exec`) to the agreed file before delegating.
	const dir = join(scratchDir, "bin");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "burrow-shim.sh");
	const body = [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		'shift # drop the supervisor-supplied "serve" positional',
		'echo "$$" > "$WARREN_ACCEPTANCE_BURROW_PID_FILE"',
		'exec bun run "$WARREN_ACCEPTANCE_BURROW_WRAPPER" "$@"',
		"",
	].join("\n");
	await writeFile(path, body);
	await chmod(path, 0o755);
	return path;
}

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: { id: string; gitUrl: string }[] }>(
		"GET",
		"/projects",
		200,
	);
	const found = list.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return { id: found.id };
	const created = await http.expectJson<{ id: string }>("POST", "/projects", 201, {
		body: { gitUrl },
	});
	return { id: created.id };
}

async function readPid(pidFile: string, timeoutMs: number): Promise<number> {
	return pollAcceptance({
		label: "burrow pid file",
		id: pidFile,
		timeoutMs,
		intervalMs: 200,
		fetchRow: async (): Promise<number | null> => {
			if (!existsSync(pidFile)) return null;
			try {
				const raw = (await readFile(pidFile, "utf8")).trim();
				const n = Number.parseInt(raw, 10);
				return Number.isInteger(n) && n > 0 ? n : null;
			} catch {
				return null;
			}
		},
		isDone: (pid): pid is number => pid !== null,
		describe: (pid) => (pid === null ? "missing or invalid" : String(pid)),
	});
}

async function waitForNewPid(
	pidFile: string,
	oldPid: number,
	oldMtime: number,
	timeoutMs: number,
): Promise<number> {
	return pollAcceptance({
		label: "supervisor burrow pid",
		id: pidFile,
		timeoutMs,
		intervalMs: 200,
		fetchRow: async (): Promise<number | null> => {
			try {
				const stats = await stat(pidFile);
				if (stats.mtimeMs <= oldMtime) return null;
				const raw = (await readFile(pidFile, "utf8")).trim();
				const n = Number.parseInt(raw, 10);
				// The pid file may briefly disappear or hold the old pid if the
				// supervisor unlinked it between writes — treat as transient.
				return Number.isInteger(n) && n > 0 && n !== oldPid ? n : null;
			} catch {
				return null;
			}
		},
		isDone: (pid): pid is number => pid !== null,
		describe: (pid) => (pid === null ? `no new pid yet (old=${oldPid})` : String(pid)),
	});
}

async function mtimeMs(path: string): Promise<number> {
	try {
		const stats = await stat(path);
		return stats.mtimeMs;
	} catch {
		return 0;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function pickPort(): number {
	return PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SPAN);
}

function randomToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

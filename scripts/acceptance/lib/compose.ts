/**
 * Container boot for the acceptance harness (`--mode container`).
 *
 * Brings up a real warren+burrow stack via `docker compose up -d --build`
 * using the canonical `docker-compose.yml` plus a per-run override file.
 * The override is what isolates the run from any dev compose stack:
 *
 *   - unique compose project name (`warren-acceptance-<random>`),
 *   - unique container name (avoids a name clash with an idle dev stack),
 *   - a random ephemeral host port published to the container's :8080,
 *   - explicit env overrides (no .env file required at the repo root):
 *       WARREN_API_TOKEN, WARREN_BURROW_NO_AUTH=1 (mx-24f580), an empty
 *       CANOPY_REPO_URL so /readyz takes the "no library" branch.
 *   - an anonymous /data volume that gets removed on `compose down -v`.
 *   - a `build:` section pointing at this checkout's Dockerfile. The base
 *     compose file pulls the published ghcr.io image (warren-26be) and
 *     comments its build block out; acceptance must exercise the local
 *     Dockerfile, so the override puts it back under a `warren:acceptance`
 *     tag.
 *
 * Why this is a thin wrapper, not a re-implementation of inproc.ts:
 *   - The supervisor inside the container owns process lifecycle. We do
 *     not get killWarren/restartWarren for free — those would
 *     fight the supervisor's restart policy and aren't a useful test of
 *     production behaviour anyway. Scenarios that need lifecycle declare
 *     `modes: ["in-proc"]` and stay in-proc-only.
 *   - The `warren` CLI is on the container PATH (Dockerfile symlinks it
 *     to /usr/local/bin/warren), but scenarios that shell warren as a
 *     child still run on the *host*; the harness doesn't `docker exec`
 *     into the container. Scenarios that need to invoke the CLI declare
 *     in-proc-only.
 *   - Fixtures (canopy library + sample project) live on the host
 *     filesystem and are reachable only via `git clone <local-path>`.
 *     The container can't see them without bind-mounts the production
 *     compose file deliberately doesn't include. Scenarios that need
 *     fixtures (anything that calls POST /agents/refresh or POST
 *     /projects) declare in-proc-only too.
 *
 * What container mode actually verifies, then, is the deploy-shape
 * concerns the in-proc harness can't: the image builds, the supervisor
 * boots burrow + warren as siblings inside the four bwrap-friendly
 * security flags, /healthz responds, /readyz returns a structured body,
 * and the built-in agents are seeded so a fresh install can dispatch a
 * run without any external dependencies. Scenario 13 carries those
 * assertions.
 *
 * Container mode requires `docker` on PATH and a running Docker daemon.
 * Boot fails fast with a clear error if either is missing.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { waitForHealthz } from "./poll.ts";

export interface ComposeBootOptions {
	readonly tmpRoot: string;
	readonly token: string;
	/** Repo root that holds docker-compose.yml + Dockerfile. */
	readonly repoRoot: string;
	/** Override the published host port. Default: random ephemeral. */
	readonly hostPort?: number;
	/** Build the image as part of `compose up`. Default true. */
	readonly build?: boolean;
}

export interface ComposeBootHandle {
	readonly warrenUrl: string;
	readonly token: string;
	readonly tmpRoot: string;
	readonly projectName: string;
	readonly hostPort: number;
	stop(): Promise<void>;
}

const HEALTHZ_WAIT_TIMEOUT_MS = 120_000; // first-run image build + boot can be slow

export async function bootCompose(opts: ComposeBootOptions): Promise<ComposeBootHandle> {
	await assertDockerAvailable();

	const projectName = `warren-acceptance-${randomSuffix()}`;
	const hostPort = opts.hostPort ?? pickPort();
	const overridePath = join(opts.tmpRoot, "compose-override.yml");
	const dataDir = join(opts.tmpRoot, "compose-data");
	await mkdir(dataDir, { recursive: true });
	await writeFile(
		overridePath,
		renderOverride({
			projectName,
			hostPort,
			token: opts.token,
			build: opts.build !== false,
			repoRoot: opts.repoRoot,
		}),
	);

	const composeFiles = [join(opts.repoRoot, "docker-compose.yml"), overridePath];
	const baseArgs = composeArgs(projectName, composeFiles);

	const upArgs = [...baseArgs, "up", "-d", "--remove-orphans"];
	if (opts.build !== false) upArgs.push("--build");

	const upEnv = buildComposeEnv();
	const upResult = await runCompose(upArgs, opts.repoRoot, upEnv);
	if (upResult.exitCode !== 0) {
		throw new Error(
			`docker compose up failed (exit ${upResult.exitCode}):\nstdout: ${upResult.stdout}\nstderr: ${upResult.stderr}`,
		);
	}

	const warrenUrl = `http://127.0.0.1:${hostPort}`;
	try {
		await waitForHealthz(warrenUrl, HEALTHZ_WAIT_TIMEOUT_MS);
	} catch (err) {
		// Stream container logs into the error so a boot failure isn't a
		// silent timeout — the operator needs to see what crashed inside.
		const logs = await dumpLogs(projectName, opts.repoRoot, composeFiles).catch(() => "");
		await downStack(projectName, opts.repoRoot, composeFiles).catch(() => undefined);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`container boot failed waiting for /healthz: ${message}\n--- compose logs ---\n${logs}`,
		);
	}

	return {
		warrenUrl,
		token: opts.token,
		tmpRoot: opts.tmpRoot,
		projectName,
		hostPort,
		stop: async () => {
			await downStack(projectName, opts.repoRoot, composeFiles).catch(() => undefined);
			try {
				await rm(opts.tmpRoot, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup — leftover temp dirs are noise, not bugs.
			}
		},
	};
}

interface ComposeOverrideOptions {
	readonly projectName: string;
	readonly hostPort: number;
	readonly token: string;
	/** Re-add the `build:` section the base compose file no longer carries. */
	readonly build: boolean;
	readonly repoRoot: string;
}

export function renderOverride(opts: ComposeOverrideOptions): string {
	// We deliberately do NOT inherit env_file: ./.env from the base compose
	// file — the override blanks it via `env_file: []` and supplies the
	// minimum-needed environment inline. Acceptance must work on a clean
	// checkout that doesn't have a .env file authored.
	//
	// Volumes are inherited from the base file unchanged: the base mounts
	// the named `warren_data` volume + a CANOPY_SOURCE_DIR bind that
	// defaults to /dev/null (harmless when unset). The compose project
	// name namespaces the volume per-run, so the data directory is fresh.
	//
	// The token is interpolated literally into the YAML rather than passed
	// via `${WARREN_API_TOKEN}` interpolation: the token is single-use and
	// already on disk in the harness's tmp dir alongside fixtures, and
	// inlining sidesteps biome's noTemplateCurlyInString lint.
	//
	// Build section (warren-26be): the base compose file now PULLS the
	// published ghcr.io control-plane image and keeps its `build:` block
	// commented out, so a fresh clone self-hosts without a toolchain.
	// Container-mode acceptance wants the opposite contract — "the image
	// builds" is one of the deploy-shape concerns it exists to verify — so
	// the override re-adds `build:` against an absolute repo-root context
	// and retags the result locally, leaving the published tag untouched.
	const lines = ["services:", "  warren:", `    container_name: ${opts.projectName}`];
	if (opts.build) {
		lines.push(
			"    image: warren:acceptance",
			"    build:",
			`      context: ${opts.repoRoot}`,
			"      dockerfile: Dockerfile",
		);
	}
	lines.push(
		"    ports: !override",
		`      - '${opts.hostPort}:8080'`,
		"    env_file: []",
		"    environment:",
		`      WARREN_API_TOKEN: '${opts.token}'`,
		"      WARREN_BURROW_NO_AUTH: '1'",
		"      WARREN_LOG_LEVEL: warn",
		"      WARREN_DISABLE_UI: '1'",
		"      CANOPY_REPO_URL: ''",
		"",
	);
	return lines.join("\n");
}

function buildComposeEnv(): Record<string, string> {
	// Compose still reads PATH/HOME/DOCKER_HOST/DOCKER_CONTEXT from the
	// process env, but the warren container's runtime env is supplied by
	// the inline `environment:` block in the override yaml — no host env
	// passthrough needed (and avoiding it keeps secrets out of compose
	// child processes by accident).
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

function composeArgs(projectName: string, composeFiles: readonly string[]): string[] {
	const args: string[] = ["compose", "-p", projectName];
	for (const file of composeFiles) {
		args.push("-f", file);
	}
	return args;
}

async function downStack(
	projectName: string,
	repoRoot: string,
	composeFiles: readonly string[],
): Promise<void> {
	const args = [...composeArgs(projectName, composeFiles), "down", "-v", "--timeout", "5"];
	await runCompose(args, repoRoot, buildComposeEnv());
}

async function dumpLogs(
	projectName: string,
	repoRoot: string,
	composeFiles: readonly string[],
): Promise<string> {
	const args = [...composeArgs(projectName, composeFiles), "logs", "--no-color", "--tail", "200"];
	const result = await runCompose(args, repoRoot, buildComposeEnv());
	return result.stdout + (result.stderr ? `\n${result.stderr}` : "");
}

async function assertDockerAvailable(): Promise<void> {
	try {
		const proc = Bun.spawn({
			cmd: ["docker", "info", "--format", "{{.ServerVersion}}"],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(
				`docker daemon is not reachable (\`docker info\` exited ${exitCode}): ${stderr.trim()}`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`container mode requires docker on PATH and a running daemon: ${message}. Start Docker Desktop or set --mode in-proc.`,
		);
	}
}

interface ComposeRunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

async function runCompose(
	args: readonly string[],
	cwd: string,
	env: Record<string, string>,
): Promise<ComposeRunResult> {
	const proc = Bun.spawn({
		cmd: ["docker", ...args],
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode: exitCode ?? 0 };
}

function pickPort(): number {
	// 32_000–60_000 ephemeral range, randomized so parallel runs don't
	// trample. Real conflicts surface as boot timeouts, not silent fails.
	return 32_000 + Math.floor(Math.random() * 28_000);
}

function randomSuffix(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

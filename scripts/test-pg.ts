#!/usr/bin/env bun
/**
 * Postgres-matrix test runner (warren-0d10, plan pl-da5b step 1).
 *
 * Boots a disposable `postgres:16` container in Docker, waits for it to
 * accept connections, then runs `bun test` with the env vars that flip
 * the dialect-polymorphic repo tests (R-13, pl-f1be) onto the postgres
 * substrate. After the test process exits — pass or fail — the
 * container is stopped so re-runs start from a clean slate.
 *
 * This is the local mirror of `.github/workflows/ci-postgres.yml`: same
 * postgres image, same DB name, same env contract
 * (`WARREN_TEST_DIALECT=postgres` + `WARREN_TEST_PG_URL=...`), so the
 * tests that gate on `isPostgresTestEnabled()` (src/db/testing.ts) light
 * up exactly the same way they do in CI.
 *
 * Usage:
 *
 *   bun run test:pg                       # full matrix on a fresh container
 *   bun run test:pg src/db/repos/runs.test.ts   # target a single suite
 *   bun run test:pg -- --reporter=junit ...     # forward args to `bun test`
 *
 * Flags (consumed by this script, not forwarded to `bun test`):
 *
 *   --keep    Skip the teardown step; leaves the container running so
 *             you can `psql` into it for poking. Re-run the script
 *             later with `--reuse` (or just stop it by hand) to clean
 *             up.
 *   --reuse   Don't boot a new container if `warren-test-pg` is
 *             already running; just connect to it.
 *   --port=N  Host port to publish 5432 on (default 55432). Override
 *             if you already have postgres bound there.
 *
 * Requires: docker on PATH + a running Docker daemon. The script
 * exits non-zero with a copy-paste hint if either is missing.
 */

import { spawn, spawnSync } from "node:child_process";

const CONTAINER_NAME = "warren-test-pg";
const POSTGRES_IMAGE = "postgres:16";
const POSTGRES_USER = "warren";
const POSTGRES_PASSWORD = "warren";
const POSTGRES_DB = "warren_test";
const DEFAULT_HOST_PORT = 55432;
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 500;

interface ParsedArgs {
	readonly keep: boolean;
	readonly reuse: boolean;
	readonly port: number;
	readonly bunTestArgs: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	let keep = false;
	let reuse = false;
	let port = DEFAULT_HOST_PORT;
	const bunTestArgs: string[] = [];
	let passthrough = false;
	for (const arg of argv) {
		if (passthrough) {
			bunTestArgs.push(arg);
			continue;
		}
		if (arg === "--") {
			passthrough = true;
			continue;
		}
		if (arg === "--keep") {
			keep = true;
			continue;
		}
		if (arg === "--reuse") {
			reuse = true;
			continue;
		}
		if (arg.startsWith("--port=")) {
			const raw = arg.slice("--port=".length);
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
				throw new Error(`--port expects a TCP port in [1, 65535]; got ${JSON.stringify(raw)}`);
			}
			port = parsed;
			continue;
		}
		bunTestArgs.push(arg);
	}
	return { keep, reuse, port, bunTestArgs };
}

function runDocker(args: readonly string[]): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("docker", args, { encoding: "utf8" });
	if (result.error) {
		throw new Error(
			`failed to invoke \`docker\`: ${result.error.message}. ` +
				"Install Docker and ensure the daemon is running.",
		);
	}
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? 1,
	};
}

function assertDockerAvailable(): void {
	const info = runDocker(["info", "--format", "{{.ServerVersion}}"]);
	if (info.status !== 0) {
		throw new Error(
			`docker daemon is not reachable (\`docker info\` exited ${info.status}): ${info.stderr.trim()}. ` +
				"Start Docker Desktop (or your daemon of choice) and retry.",
		);
	}
}

function isContainerRunning(name: string): boolean {
	const result = runDocker(["ps", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]);
	if (result.status !== 0) {
		throw new Error(`\`docker ps\` failed: ${result.stderr.trim()}`);
	}
	return result.stdout.split("\n").some((line) => line.trim() === name);
}

function bootContainer(port: number): void {
	console.error(`[test:pg] booting ${POSTGRES_IMAGE} as ${CONTAINER_NAME} on host port ${port}…`);
	const result = runDocker([
		"run",
		"-d",
		"--rm",
		"--name",
		CONTAINER_NAME,
		"-e",
		`POSTGRES_USER=${POSTGRES_USER}`,
		"-e",
		`POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
		"-e",
		`POSTGRES_DB=${POSTGRES_DB}`,
		"-p",
		`${port}:5432`,
		POSTGRES_IMAGE,
	]);
	if (result.status !== 0) {
		throw new Error(`\`docker run\` failed: ${result.stderr.trim()}`);
	}
}

function stopContainer(): void {
	console.error(`[test:pg] stopping ${CONTAINER_NAME}…`);
	const result = runDocker(["stop", CONTAINER_NAME]);
	if (result.status !== 0) {
		console.error(
			`[test:pg] warning: \`docker stop\` exited ${result.status}: ${result.stderr.trim()}`,
		);
	}
}

async function waitForReady(): Promise<void> {
	const deadline = Date.now() + READINESS_TIMEOUT_MS;
	let lastErr = "";
	while (Date.now() < deadline) {
		const result = runDocker([
			"exec",
			CONTAINER_NAME,
			"pg_isready",
			"-U",
			POSTGRES_USER,
			"-d",
			POSTGRES_DB,
		]);
		if (result.status === 0) {
			return;
		}
		lastErr = result.stderr.trim() || result.stdout.trim();
		await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
	}
	throw new Error(
		`postgres did not become ready within ${READINESS_TIMEOUT_MS}ms. Last pg_isready output: ${lastErr}`,
	);
}

function runBunTest(port: number, extraArgs: readonly string[]): Promise<number> {
	const url = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;
	console.error(`[test:pg] running \`bun test ${extraArgs.join(" ")}\` against ${url}`);
	return new Promise((resolve, reject) => {
		const child = spawn("bun", ["test", ...extraArgs], {
			stdio: "inherit",
			env: {
				...process.env,
				WARREN_TEST_DIALECT: "postgres",
				WARREN_TEST_PG_URL: url,
			},
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	assertDockerAvailable();

	const already = isContainerRunning(CONTAINER_NAME);
	if (already && !args.reuse) {
		throw new Error(
			`container ${CONTAINER_NAME} is already running. Re-run with --reuse to attach to it, ` +
				`or stop it first: \`docker stop ${CONTAINER_NAME}\`.`,
		);
	}
	const booted = !already;
	if (booted) {
		bootContainer(args.port);
	} else {
		console.error(`[test:pg] reusing existing ${CONTAINER_NAME} container`);
	}

	let exitCode = 1;
	try {
		await waitForReady();
		exitCode = await runBunTest(args.port, args.bunTestArgs);
	} finally {
		if (booted && !args.keep) {
			stopContainer();
		} else if (args.keep) {
			console.error(
				`[test:pg] --keep set; leaving ${CONTAINER_NAME} running. Stop it with \`docker stop ${CONTAINER_NAME}\`.`,
			);
		}
	}
	return exitCode;
}

if (import.meta.main) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(`[test:pg] ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}

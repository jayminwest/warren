/**
 * The docker spawn seam (warren-3732) — a `DriveDeps.spawn` implementation
 * that runs the agent inside a sibling container instead of bwrap. The
 * drive loop (`src/runtime/local/drive.ts`) calls it with the same
 * `SandboxProfile` + `SpawnCommand` it hands `runSandboxed`; this seam maps
 * them onto a `docker run` (`./container-spec.ts`) and adapts the docker
 * CLI child onto the `SpawnResult` contract:
 *
 *   - stdin pipes through to the container (`-i`), so batch runtimes get
 *     their prompt then EOF, and stdin-held runtimes (pi) keep mid-run
 *     steering over the live pipe — `holdStdin` semantics preserved.
 *   - `exited` resolves with the CONTAINER's exit code (`docker run`
 *     propagates it), after which the seam probes the dead container for
 *     the OOMKilled flag and force-removes it (no `--rm` — the flag would
 *     be uninspectable).
 *   - `cancel()` force-removes the container (`docker rm -f` kills it) and
 *     kills the CLI child. Idempotent.
 *   - `oomKilled()` reports the daemon's cgroup OOM verdict, the docker
 *     counterpart of the bwrap cgroup probe (burrow-2083 parity).
 *
 * Secrets reach the container via an `--env-file` in a private tmp dir
 * (mode 0600), never on the argv (burrow-ab95 posture). The file is
 * unlinked when the container exits or is cancelled.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import { type DockerConfig, resolveDockerConfig } from "./config.ts";
import { buildDockerRunSpec } from "./container-spec.ts";

/** Injectable seams — tests script the docker CLI without a daemon. */
export interface DockerSpawnDeps {
	/** Process spawn — defaults to `Bun.spawn`. */
	readonly spawn?: (
		argv: string[],
		opts: { stdin: "pipe" | "ignore"; stdout: "pipe"; stderr: "pipe" },
	) => Bun.Subprocess;
	/** One-shot docker invocation (inspect / rm). Defaults to `Bun.spawn` + await. */
	readonly runDocker?: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;
	/** Env the config resolver reads — defaults to `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Root for the private env-file dir — defaults to `os.tmpdir()`. */
	readonly tmpRoot?: string;
}

const defaultSpawn: NonNullable<DockerSpawnDeps["spawn"]> = (argv, opts) => Bun.spawn(argv, opts);

const defaultRunDocker: NonNullable<DockerSpawnDeps["runDocker"]> = async (argv) => {
	const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout };
};

/**
 * Build the drive-loop spawn seam for the docker topology. The returned
 * function matches `DriveDeps.spawn`'s signature exactly.
 */
export function makeDockerSpawn(
	deps: DockerSpawnDeps = {},
): (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult> {
	const config = resolveDockerConfig(deps.env ?? process.env);
	const spawnProc = deps.spawn ?? defaultSpawn;
	const runDocker = deps.runDocker ?? defaultRunDocker;
	return (profile, command) =>
		spawnInContainer(config, profile, command, spawnProc, runDocker, deps);
}

async function spawnInContainer(
	config: DockerConfig,
	profile: SandboxProfile,
	command: SpawnCommand,
	spawnProc: NonNullable<DockerSpawnDeps["spawn"]>,
	runDocker: NonNullable<DockerSpawnDeps["runDocker"]>,
	deps: DockerSpawnDeps,
): Promise<SpawnResult> {
	const tmpDir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "warren-docker-"));
	const envFilePath = join(tmpDir, "container.env");
	const spec = buildDockerRunSpec(profile, command, config, envFilePath);
	writeFileSync(envFilePath, spec.envFileContents, { mode: 0o600 });

	const wantsStdin = command.stdin !== undefined;
	const proc = spawnProc(spec.argv, {
		stdin: wantsStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	await writeStringStdin(proc, command.stdin, command.holdStdin ?? false);

	let oom = false;
	let cleanedUp = false;
	const cleanup = async (): Promise<void> => {
		if (cleanedUp) return;
		cleanedUp = true;
		oom = await probeOomKilled(runDocker, config.bin, spec.containerName);
		await runDocker([config.bin, "rm", "-f", spec.containerName]).catch(() => {});
		rmSync(tmpDir, { recursive: true, force: true });
	};
	const exited = proc.exited.then(async (code) => {
		await cleanup();
		return code;
	});

	return {
		pid: proc.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited,
		cancel: () => {
			proc.kill();
			void runDocker([config.bin, "rm", "-f", spec.containerName]).catch(() => {});
			void cleanup();
		},
		closeStdin: makeCloseStdin(proc),
		writeStdin: makeWriteStdin(proc),
		oomKilled: () => oom,
	};
}

/** Probe the dead container's OOMKilled flag; a probe failure reads as false. */
async function probeOomKilled(
	runDocker: NonNullable<DockerSpawnDeps["runDocker"]>,
	bin: string,
	containerName: string,
): Promise<boolean> {
	try {
		const res = await runDocker([
			bin,
			"inspect",
			"--format",
			"{{.State.OOMKilled}}",
			containerName,
		]);
		return res.exitCode === 0 && res.stdout.trim() === "true";
	} catch {
		return false;
	}
}

/* Stdin helpers — byte-for-byte the posture of src/sandbox/sandbox.ts: the
   held pipe needs an explicit flush or the bytes never reach the container
   (burrow-029d). */

async function writeStringStdin(
	proc: Bun.Subprocess,
	stdin: SpawnCommand["stdin"],
	holdStdin: boolean,
): Promise<void> {
	if (typeof stdin !== "string") return;
	const sink = proc.stdin;
	if (!sink || typeof sink === "number") return;
	sink.write(new TextEncoder().encode(stdin));
	if (holdStdin) await sink.flush();
	else await sink.end();
}

function makeCloseStdin(proc: Bun.Subprocess): () => Promise<void> {
	let closed = false;
	return async () => {
		if (closed) return;
		closed = true;
		const sink = proc.stdin;
		if (!sink || typeof sink === "number") return;
		await sink.end();
	};
}

function makeWriteStdin(proc: Bun.Subprocess): (chunk: string) => Promise<void> {
	const encoder = new TextEncoder();
	return async (chunk: string) => {
		const sink = proc.stdin;
		if (!sink || typeof sink === "number") {
			throw new Error("docker spawn: child stdin is not writable");
		}
		sink.write(encoder.encode(chunk));
		await sink.flush();
	};
}

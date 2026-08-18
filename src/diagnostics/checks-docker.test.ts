/**
 * Docker CLI readiness probe (warren-5c42). The docker topology dispatches
 * every agent through the docker CLI, so a control plane whose CLI is
 * missing, unexecutable, or daemon-less is NOT ready — it just fails at the
 * first dispatch instead. Every case here scripts the spawn seam; no daemon
 * and no docker binary are involved.
 */

import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "../projects/clone.ts";
import {
	checkDockerCli,
	DOCKER_CLI_PROBE_TIMEOUT_MS,
	dockerCliProbeArgv,
} from "./checks-docker.ts";

/** Records what the probe execed so the argv contract stays asserted. */
function recordingSpawn(result: { stdout?: string; stderr?: string; exitCode: number }): {
	spawn: SpawnFn;
	calls: { cmd: readonly string[]; timeoutMs?: number }[];
} {
	const calls: { cmd: readonly string[]; timeoutMs?: number }[] = [];
	const spawn: SpawnFn = async (cmd, opts) => {
		calls.push({ cmd, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode };
	};
	return { spawn, calls };
}

describe("dockerCliProbeArgv", () => {
	test("probes with `version`, which needs both the CLI and a live daemon", () => {
		expect(dockerCliProbeArgv("/opt/warren/bin/docker")).toEqual([
			"/opt/warren/bin/docker",
			"version",
		]);
	});
});

describe("checkDockerCli", () => {
	test("passes when the configured CLI reaches the daemon", async () => {
		const { spawn, calls } = recordingSpawn({ stdout: "Server: Docker Desktop", exitCode: 0 });
		const check = await checkDockerCli({ spawn, dockerBin: "/data/bin/docker" });
		expect(check).toEqual({
			name: "docker_cli",
			ok: true,
			message: "`/data/bin/docker version` reached the docker daemon",
		});
		expect(calls[0]?.cmd).toEqual(["/data/bin/docker", "version"]);
		expect(calls[0]?.timeoutMs).toBe(DOCKER_CLI_PROBE_TIMEOUT_MS);
	});

	test("defaults the binary to `docker` when none is configured", async () => {
		const { spawn, calls } = recordingSpawn({ exitCode: 0 });
		await checkDockerCli({ spawn });
		expect(calls[0]?.cmd).toEqual(["docker", "version"]);
	});

	test("treats a blank WARREN_DOCKER_BIN as unset", async () => {
		const { spawn, calls } = recordingSpawn({ exitCode: 0 });
		await checkDockerCli({ spawn, dockerBin: "   " });
		expect(calls[0]?.cmd).toEqual(["docker", "version"]);
	});

	test("fails with the daemon's own text when the CLI cannot reach it", async () => {
		const { spawn } = recordingSpawn({
			stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
			exitCode: 1,
		});
		const check = await checkDockerCli({ spawn });
		expect(check.ok).toBe(false);
		expect(check.message).toContain("exited 1");
		expect(check.message).toContain("Cannot connect to the Docker daemon");
		expect(check.hint).toContain("WARREN_DOCKER_BIN");
	});

	test("falls back to stdout when a non-zero exit wrote nothing to stderr", async () => {
		const { spawn } = recordingSpawn({ stdout: "Client: 27.0.3", exitCode: 1 });
		const check = await checkDockerCli({ spawn });
		expect(check.ok).toBe(false);
		expect(check.message).toContain("Client: 27.0.3");
	});

	// The failure the quickstart actually produced: no CLI on $PATH at all.
	test("fails when the binary is missing (spawn throws)", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error('Executable not found in $PATH: "docker"');
		};
		const check = await checkDockerCli({ spawn });
		expect(check.ok).toBe(false);
		expect(check.message).toContain("could not exec `docker version`");
		expect(check.message).toContain("Executable not found in $PATH");
		expect(check.hint).toContain("EMPTY DIRECTORY");
	});

	// macOS Docker Desktop: the CLI bind mount materializes as a directory,
	// so the path stats fine and can never exec.
	test("fails when the mounted CLI path is a directory, not an executable", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("EACCES: permission denied, posix_spawn '/usr/bin/docker'");
		};
		const check = await checkDockerCli({ spawn, dockerBin: "/usr/bin/docker" });
		expect(check.ok).toBe(false);
		expect(check.message).toContain("/usr/bin/docker");
		expect(check.hint).toContain("macOS Docker Desktop");
		expect(check.hint).toContain("static linux docker CLI on the data volume");
	});

	test("honors an overridden timeout", async () => {
		const { spawn, calls } = recordingSpawn({ exitCode: 0 });
		await checkDockerCli({ spawn, timeoutMs: 250 });
		expect(calls[0]?.timeoutMs).toBe(250);
	});
});

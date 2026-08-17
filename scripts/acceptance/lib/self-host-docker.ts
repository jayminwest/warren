/**
 * Fresh-host one-liner helpers for scenario 42 (warren-1a5a, plan pl-3007
 * phase-4 exit pin).
 *
 * Scenario 13 boots warren through the compose harness with a pre-set
 * operator token and the four bwrap security flags. Scenario 42 instead
 * falsifies the campaign's HEADLINE claim directly against `docker run`:
 *
 *   - ONE `docker run`, no security_opt flags, no cap_add, no extra
 *     tokens (WARREN_API_TOKEN deliberately UNSET so first-boot minting
 *     fires, warren-ef6e),
 *   - exactly two secrets on the env: ANTHROPIC_API_KEY + GITHUB_TOKEN,
 *   - the minted operator token observed in `docker logs`,
 *   - dispatch works because WARREN_RUNTIME=docker (warren-3732) runs the
 *     agent as a sibling container — the container boundary is the
 *     sandbox, so nested bwrap and its security flags are unnecessary.
 *
 * Harness plumbing that is NOT part of the operator claim: the docker
 * socket + CLI bind mounts (the docker topology's documented
 * requirement), the path-parity data-dir bind mount, and the fixture
 * mounts that keep the run off the network. The acceptance comments call
 * each out at the argv construction site.
 */

import { AcceptanceError } from "./assert.ts";

export interface DockerResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/** Run one docker CLI invocation and capture both streams. */
export async function runDocker(argv: readonly string[]): Promise<DockerResult> {
	const proc = Bun.spawn({
		cmd: ["docker", ...argv],
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

/** Run docker and throw an AcceptanceError carrying stderr on failure. */
export async function dockerOrThrow(argv: readonly string[], label: string): Promise<DockerResult> {
	const result = await runDocker(argv);
	if (result.exitCode !== 0) {
		throw new AcceptanceError(
			`${label}: docker ${argv.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`,
		);
	}
	return result;
}

/** True when `docker` is on PATH and the daemon answers. */
export async function dockerAvailable(): Promise<boolean> {
	try {
		const result = await runDocker(["info", "--format", "{{.ServerVersion}}"]);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/** Full container logs (stdout + stderr), for mint-token scraping. */
export async function containerLogs(name: string): Promise<string> {
	const result = await dockerOrThrow(["logs", "--timestamps", name], "container logs");
	return `${result.stdout}\n${result.stderr}`;
}

/**
 * Extract the first-boot minted operator token from container logs. The
 * boot log line is a pino JSON row carrying `mintedOperatorToken`
 * (warren-ef6e; the field name dodges the token redactor on purpose).
 * Throws when the row is missing or malformed — absence means the
 * first-boot mint did not fire, which is the falsification signal.
 */
export function extractMintedToken(logs: string): string {
	const matches = [...logs.matchAll(/"mintedOperatorToken":"([^"]+)"/g)].map((m) => m[1]);
	if (matches.length === 0) {
		throw new AcceptanceError(
			`container logs carry no mintedOperatorToken row — first-boot mint did not fire:\n${logs.slice(-2000)}`,
		);
	}
	const unique = new Set(matches);
	if (unique.size !== 1) {
		throw new AcceptanceError(
			`container logs carry ${unique.size} DISTINCT minted tokens — expected exactly one mint`,
		);
	}
	const token = matches[0];
	if (token === undefined || token.length < 16) {
		throw new AcceptanceError("mintedOperatorToken row is malformed (empty or too short)");
	}
	return token;
}

/** Occurrence count of the mint line — the print-once contract. */
export function mintLineCount(logs: string): number {
	return [...logs.matchAll(/mintedOperatorToken/g)].length;
}

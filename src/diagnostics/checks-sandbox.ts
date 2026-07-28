/**
 * Sandbox readiness check for `warren doctor` and `GET /readyz`. Split
 * out of `checks.ts` (warren-5bf4) so the barrel stays under the
 * 500-line global limit; re-exported verbatim from `./checks.ts`, so
 * every importer keeps resolving unchanged.
 *
 * Covers: bwrap bring-up. Burrow socket reachability lives in the
 * allowlisted local-topology module
 * `src/runtime/local/diagnostics/burrow.ts` (warren-11cc) so this
 * diagnostics surface stays free of any direct burrow client import.
 */

import type { SpawnFn } from "../projects/clone.ts";
import type { DiagnosticCheck } from "./checks.ts";

export const BWRAP_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe `bwrap --version`. A non-zero exit, missing binary, or timeout
 * fails the check — burrow can't spawn agents without bwrap, so this
 * is the most operationally-useful "is the host wired right" signal.
 */
export async function checkBwrap(deps: {
	readonly spawn: SpawnFn;
	readonly bwrapBinary?: string;
	readonly timeoutMs?: number;
}): Promise<DiagnosticCheck> {
	const binary = deps.bwrapBinary ?? "bwrap";
	const timeoutMs = deps.timeoutMs ?? BWRAP_PROBE_TIMEOUT_MS;
	try {
		const result = await deps.spawn([binary, "--version"], {
			cwd: process.cwd(),
			timeoutMs,
		});
		if (result.exitCode !== 0) {
			return {
				name: "bwrap",
				ok: false,
				message: `bwrap --version exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
				hint: "install bwrap (e.g. apt-get install bubblewrap) and ensure it is on $PATH",
			};
		}
		return { name: "bwrap", ok: true, message: result.stdout.trim() || result.stderr.trim() };
	} catch (err) {
		return {
			name: "bwrap",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "install bwrap (e.g. apt-get install bubblewrap) and ensure it is on $PATH",
		};
	}
}

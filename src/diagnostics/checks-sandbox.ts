/**
 * Sandbox readiness check for `warren doctor` and `GET /readyz`. Split
 * out of `checks.ts` (warren-5bf4) so the barrel stays under the
 * 500-line global limit; re-exported verbatim from `./checks.ts`, so
 * every importer keeps resolving unchanged.
 *
 * Covers: bwrap bring-up. Burrow socket reachability lives in the
 * allowlisted local-topology module
 * `src/runtime/local/diagnostics/local-runtime.ts` (warren-11cc) so this
 * diagnostics surface stays free of any direct burrow client import.
 */

import type { SpawnFn } from "../projects/clone.ts";
import {
	SandboxGitPreflightError,
	type SandboxGitPreflightResult,
} from "../sandbox/git-preflight.ts";
import type { DiagnosticCheck } from "./checks.ts";

export const BWRAP_PROBE_TIMEOUT_MS = 5_000;

const INSTALL_HINT =
	"install bwrap (e.g. apt-get install bubblewrap) and ensure it is on $PATH; " +
	"if it is installed, the host kernel must allow unprivileged user namespaces " +
	"(e.g. sysctl kernel.unprivileged_userns_clone=1 on Debian, or " +
	"kernel.unprivileged_userns_apparmor_policy=0 on Ubuntu 23.10+)";

/**
 * The probe argv (warren-daef). `bwrap --version` passes on hosts where
 * bwrap exists but cannot actually create a sandbox (user namespaces
 * disabled, missing setuid bit, AppArmor policy), and the breakage then
 * surfaces downstream as a misleading `no_model_response` run failure.
 * So the probe EXERCISES a minimal sandbox creation the way burrow's
 * Linux spawn does (burrow SPEC §8.1): unshare every namespace, keep
 * host networking (burrow's `restricted` policy shape), bind the host
 * root read-only so `/bin/true` resolves inside, die with the parent,
 * and exec a no-op. A host that cannot create user namespaces fails
 * here with e.g. `bwrap: setting up uid map: Permission denied`.
 */
export function bwrapProbeArgv(binary: string): string[] {
	return [
		binary,
		"--unshare-all",
		"--share-net",
		"--ro-bind",
		"/",
		"/",
		"--die-with-parent",
		"--",
		"/bin/true",
	];
}

/**
 * Functionally probe that the resolved git EXECUTES inside the composed
 * sandbox profile (warren-1219): `git --version` runs through the same
 * confinement a real run gets. A PATH-resolved git whose dylibs sit
 * outside the readable paths (the macOS nix spike) fails HERE, at doctor
 * time, instead of surfacing post-hoc as a dropped_commit run failure.
 * The probe itself lives in `src/sandbox/git-preflight.ts`; this is the
 * doctor/readyz-shaped adapter.
 */
export async function checkSandboxGit(deps: {
	/** Result seam — production wires the (boot-cached) probe, tests stub it. */
	readonly probe: () => Promise<SandboxGitPreflightResult>;
}): Promise<DiagnosticCheck> {
	let result: SandboxGitPreflightResult;
	try {
		result = await deps.probe();
	} catch (err) {
		return {
			name: "sandbox_git",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: err instanceof SandboxGitPreflightError ? err.recoveryHint : INSTALL_HINT,
		};
	}
	if (result.ok) {
		return {
			name: "sandbox_git",
			ok: true,
			message: result.message,
			...(result.hint !== undefined ? { hint: result.hint } : {}),
		};
	}
	return {
		name: "sandbox_git",
		ok: false,
		message: result.message,
		hint: result.hint ?? INSTALL_HINT,
	};
}

/**
 * Functionally probe bwrap by creating a minimal sandbox, not just
 * asking for `--version` (warren-daef). A non-zero exit, missing
 * binary, or timeout fails the check — burrow can't spawn agents
 * without a working bwrap, so this is the most operationally-useful
 * "is the host wired right" signal.
 *
 * Linux-only: burrow sandboxes with `sandbox-exec` on macOS and with
 * pods under the K8s runtime, so probing bwrap there would report a
 * failure that means nothing. Non-Linux platforms degrade to an ok
 * "skipped" result; K8s never reaches this check (the readyz/doctor
 * callers gate on the local topology, warren-c128).
 */
export async function checkBwrap(deps: {
	readonly spawn: SpawnFn;
	readonly bwrapBinary?: string;
	readonly timeoutMs?: number;
	readonly platform?: NodeJS.Platform;
}): Promise<DiagnosticCheck> {
	const platform = deps.platform ?? process.platform;
	if (platform !== "linux") {
		return {
			name: "bwrap",
			ok: true,
			message: `skipped: bwrap is Linux-only (burrow uses sandbox-exec on ${platform})`,
		};
	}
	const binary = deps.bwrapBinary ?? "bwrap";
	const timeoutMs = deps.timeoutMs ?? BWRAP_PROBE_TIMEOUT_MS;
	try {
		const result = await deps.spawn(bwrapProbeArgv(binary), {
			cwd: process.cwd(),
			timeoutMs,
		});
		if (result.exitCode !== 0) {
			return {
				name: "bwrap",
				ok: false,
				message: `bwrap sandbox probe exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
				hint: INSTALL_HINT,
			};
		}
		return {
			name: "bwrap",
			ok: true,
			message: "bwrap created a minimal sandbox (unshare-all + ro-bind / + exec /bin/true)",
		};
	} catch (err) {
		return {
			name: "bwrap",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: INSTALL_HINT,
		};
	}
}

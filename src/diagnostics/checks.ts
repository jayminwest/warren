/**
 * Shared readiness checks for `warren doctor` and `GET /readyz`.
 *
 * This module is a thin BARREL (warren-5bf4 / pl-f176): the shared
 * types/consts live here, and the three check groups are implemented in
 * sibling files that this module re-exports — so every importer
 * (src/server/handlers/diagnostics.ts, src/cli/commands/doctor.ts, and
 * the three sibling test files), which all import from `./checks.ts`,
 * keeps resolving unchanged.
 *
 *   - checks-docker.ts — the docker CLI probe for the docker topology
 *     (warren-5c42): the sibling-container backend cannot dispatch
 *     without an executable CLI that reaches a daemon.
 *   - checks-sandbox.ts — bwrap bring-up and the canopy clone's
 *     existence + cleanliness. Burrow socket reachability lives in the
 *     allowlisted `src/runtime/local/diagnostics/local-runtime.ts` module
 *     (warren-11cc), out of this diagnostics surface.
 *   - checks-config.ts — per-project `.warren/` parsing (fatal +
 *     deprecation), resolved DB dialect, live `SELECT 1` reachability.
 *   - checks-preview.ts — preview port + live-count saturation and
 *     signed-cookie token strength.
 *   - redact.ts — the body/log split that keeps raw driver text, token
 *     lengths, and absolute paths out of every check message (warren-51de).
 *
 * Each check returns `{ name, ok, message?, hint? }`. Callers decide
 * how to render (newline-delimited JSON for doctor, one envelope for
 * readyz). The functions themselves are pure modulo their injected
 * `spawn` / `exists` / `sandboxClient` seams — tests can stub all I/O.
 */

export interface DiagnosticCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly message?: string;
	readonly hint?: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;
export type ExistsFn = (path: string) => boolean;

/**
 * Minimal logger seam for checks that must LOG a failure detail they
 * refuse to put on the wire (warren-51de) — see `./redact.ts`. Pino and a
 * console-shaped test stub both satisfy it structurally. Optional at every
 * call site, so surfaces with no logger (the `warren doctor` CLI) simply
 * drop the detail rather than leak it.
 */
export interface DiagnosticLogger {
	warn(obj: object, msg?: string): void;
}

/**
 * Agent git-identity check (warren-e7b7). When both
 * `WARREN_GIT_AUTHOR_NAME` and `WARREN_GIT_AUTHOR_EMAIL` are set, agent
 * commits attribute to the operator's dedicated bot identity. When either
 * is unset, agent commits attribute to whatever identity the sandbox
 * happens to have — the Local supervisor's warn fallback logs it, but the
 * K8s topology has no supervisor, so this check is the operator's signal.
 * Always `ok: true` (a WARNING, not a failure): a warren install works
 * without the vars, the attribution is just wrong. Never echoes the
 * configured values onto the wire (warren-51de precedent).
 */
export function checkGitIdentity(env: EnvLike): DiagnosticCheck {
	const name = env.WARREN_GIT_AUTHOR_NAME?.trim() ?? "";
	const email = env.WARREN_GIT_AUTHOR_EMAIL?.trim() ?? "";
	if (name !== "" && email !== "") {
		return {
			name: "git_identity",
			ok: true,
			message: "WARREN_GIT_AUTHOR_NAME / WARREN_GIT_AUTHOR_EMAIL configured",
		};
	}
	return {
		name: "git_identity",
		ok: true,
		message:
			"warning: WARREN_GIT_AUTHOR_NAME / WARREN_GIT_AUTHOR_EMAIL not set — agent commits attribute to the sandbox's fallback git identity",
		hint: "set both vars to a dedicated GitHub machine account's noreply address (e.g. warren-bot <12345+warren-bot@users.noreply.github.com>)",
	};
}

export {
	type CheckWarrenConfigDeps,
	checkDatabaseReachable,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	checkWarrenDb,
	type WarrenConfigCheckProject,
} from "./checks-config.ts";
export {
	checkDockerCli,
	DOCKER_CLI_HINT,
	DOCKER_CLI_PROBE_TIMEOUT_MS,
	dockerCliProbeArgv,
} from "./checks-docker.ts";
export {
	checkPreviewAuthStrength,
	checkPreviewMaxLive,
	checkPreviewPortAllocator,
	PREVIEW_MIN_TOKEN_LENGTH,
	PREVIEW_TOKEN_PLACEHOLDERS,
	type PreviewLiveCountProbe,
	type PreviewPortUsageProbe,
} from "./checks-preview.ts";
export { BWRAP_PROBE_TIMEOUT_MS, checkBwrap, checkSandboxGit } from "./checks-sandbox.ts";
export { classifyDbFailure, type DbFailureReason, dbFailureMessage } from "./redact.ts";

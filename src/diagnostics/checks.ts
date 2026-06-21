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
 *   - checks-sandbox.ts — bwrap bring-up, the canopy clone's existence
 *     + cleanliness, and burrow socket reachability (single + pool).
 *   - checks-config.ts — per-project `.warren/` parsing (fatal +
 *     deprecation), resolved DB dialect, live `SELECT 1` reachability.
 *   - checks-preview.ts — preview port + live-count saturation and
 *     signed-cookie token strength.
 *
 * Each check returns `{ name, ok, message?, hint? }`. Callers decide
 * how to render (newline-delimited JSON for doctor, one envelope for
 * readyz). The functions themselves are pure modulo their injected
 * `spawn` / `exists` / `burrowClient` seams — tests can stub all I/O.
 */

export interface DiagnosticCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly message?: string;
	readonly hint?: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;
export type ExistsFn = (path: string) => boolean;

export {
	type CheckWarrenConfigDeps,
	checkDatabaseReachable,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	checkWarrenDb,
	type WarrenConfigCheckProject,
} from "./checks-config.ts";
export {
	checkPreviewAuthStrength,
	checkPreviewMaxLive,
	checkPreviewPortAllocator,
	PREVIEW_MIN_TOKEN_LENGTH,
	PREVIEW_TOKEN_PLACEHOLDERS,
	type PreviewLiveCountProbe,
	type PreviewPortUsageProbe,
} from "./checks-preview.ts";
export {
	BWRAP_PROBE_TIMEOUT_MS,
	CANOPY_GIT_TIMEOUT_MS,
	checkBurrowPoolReachable,
	checkBurrowReachable,
	checkBwrap,
	checkCanopyClean,
	checkCanopyClone,
} from "./checks-sandbox.ts";

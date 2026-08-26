/**
 * Resolve the project-management module's environment-driven config.
 *
 * Two pieces of state matter:
 *   1. Where cloned project repos live on disk (one subdir per `<owner>/<name>`).
 *   2. Which `git` binary to invoke for clone + branch detection.
 *
 * Env contract:
 *   WARREN_PROJECTS_DIR   root for cloned repos — defaults to
 *                         `<WARREN_DATA_DIR>/projects`, and to /data/projects
 *                         when WARREN_DATA_DIR is unset too
 *   WARREN_DATA_DIR       the deploy's persistent volume — the projects root
 *                         derives from it (see below)
 *   WARREN_GIT_BINARY     git binary path — defaults to "git" (shared with canopy registry)
 *   WARREN_GIT_TIMEOUT_MS host-clone git operation timeout in milliseconds —
 *                         registration clones and refresh fetches. Unset falls
 *                         back to DEFAULT_GIT_TIMEOUT_MS (120s). Large external
 *                         repos (the first payer: openclaw at ~2.9GB) cannot
 *                         finish a full clone in 120s, and the server offered
 *                         no way to say so short of a code change.
 *
 * Why the projects root derives from `WARREN_DATA_DIR` (warren-5c42): the
 * README quickstart mounts ONE volume and points `WARREN_DATA_DIR` at it
 * (`-e WARREN_DATA_DIR=/srv/warren -v /srv/warren:/srv/warren`). With a
 * hardcoded `/data/projects` default, clones landed outside that volume, so
 * every docker-runtime dispatch died binding the workspace into the agent
 * container (`bind source path does not exist: .../<repo>/.git`). The local
 * state roots already derive this way (`src/runtime/local/paths.ts`); this
 * closes the same gap for the clone root. `WARREN_DATA_DIR` unset still
 * resolves to `/data/projects`, preserving the historical default exactly.
 */

import { join } from "node:path";
import { ValidationError } from "../core/errors.ts";

/**
 * Data root fallback when `WARREN_DATA_DIR` is unset. Mirrors
 * `DEFAULT_DATA_DIR` in `src/server/config.ts` and `DEFAULT_LOCAL_DATA_DIR`
 * in `src/runtime/local/paths.ts` (all three kept dependency-free).
 */
export const DEFAULT_DATA_DIR = "/data";

/** Subdirectory of the data root that holds one clone per `<owner>/<name>`. */
export const PROJECTS_SUBDIR = "projects";

/** The projects root with neither `WARREN_PROJECTS_DIR` nor `WARREN_DATA_DIR` set. */
export const DEFAULT_PROJECTS_DIR = join(DEFAULT_DATA_DIR, PROJECTS_SUBDIR);

export interface ProjectsConfig {
	readonly root: string;
	readonly gitBinary: string;
	/**
	 * Operator override for host-clone git timeouts (WARREN_GIT_TIMEOUT_MS).
	 * Absent → callers fall back to DEFAULT_GIT_TIMEOUT_MS.
	 */
	readonly gitTimeoutMs?: number;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The projects root implied by the data dir alone — what an unset
 * `WARREN_PROJECTS_DIR` falls back to. A blank/whitespace `WARREN_DATA_DIR`
 * degrades to the default root, matching `resolveLocalStateRoots`.
 */
export function defaultProjectsRoot(env: EnvLike): string {
	const dataDir = env.WARREN_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
	return join(dataDir, PROJECTS_SUBDIR);
}

export function loadProjectsConfigFromEnv(env: EnvLike = process.env): ProjectsConfig {
	const fallback = defaultProjectsRoot(env);
	const root = env.WARREN_PROJECTS_DIR ?? fallback;
	if (root === "") {
		throw new ValidationError("WARREN_PROJECTS_DIR is set to an empty string", {
			recoveryHint: `unset WARREN_PROJECTS_DIR to fall back to ${fallback}`,
		});
	}

	const rawTimeout = env.WARREN_GIT_TIMEOUT_MS?.trim();
	let gitTimeoutMs: number | undefined;
	if (rawTimeout !== undefined && rawTimeout !== "") {
		const parsed = Number(rawTimeout);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new ValidationError(
				`WARREN_GIT_TIMEOUT_MS must be a positive integer of milliseconds, got "${rawTimeout}"`,
				{ recoveryHint: "unset it to fall back to the 120000ms default" },
			);
		}
		gitTimeoutMs = parsed;
	}

	return {
		root,
		gitBinary: env.WARREN_GIT_BINARY ?? "git",
		...(gitTimeoutMs !== undefined ? { gitTimeoutMs } : {}),
	};
}

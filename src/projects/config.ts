/**
 * Resolve the project-management module's environment-driven config.
 *
 * Two pieces of state matter:
 *   1. Where cloned project repos live on disk (one subdir per `<owner>/<name>`).
 *   2. Which `git` binary to invoke for clone + branch detection.
 *
 * Env contract:
 *   WARREN_PROJECTS_DIR   root for cloned repos — defaults to /data/projects
 *   WARREN_GIT_BINARY     git binary path — defaults to "git" (shared with canopy registry)
 */

import { ValidationError } from "../core/errors.ts";

export const DEFAULT_PROJECTS_DIR = "/data/projects";

export interface ProjectsConfig {
	readonly root: string;
	readonly gitBinary: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function loadProjectsConfigFromEnv(env: EnvLike = process.env): ProjectsConfig {
	const root = env.WARREN_PROJECTS_DIR ?? DEFAULT_PROJECTS_DIR;
	if (root === "") {
		throw new ValidationError("WARREN_PROJECTS_DIR is set to an empty string", {
			recoveryHint: `unset WARREN_PROJECTS_DIR to fall back to ${DEFAULT_PROJECTS_DIR}`,
		});
	}

	return {
		root,
		gitBinary: env.WARREN_GIT_BINARY ?? "git",
	};
}

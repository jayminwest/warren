/**
 * Public re-exports for the project-management module. Internal modules
 * import from here so file layout under `projects/` can shift without
 * rippling out to call sites.
 */

// Row type re-export at the domain seam (warren-02c9): the drizzle schema
// stays the source of the inferred type; handlers import `ProjectRow` here.
export type { ProjectRow } from "../db/schema.ts";
export {
	detectProjectFeatures,
	PROJECT_FEATURE_DIRS,
	type ProjectFeatureFlags,
} from "./capabilities.ts";
export {
	type CloneProjectInput,
	type CloneProjectResult,
	cloneProjectRepo,
	DEFAULT_GIT_TIMEOUT_MS,
	type SpawnFn,
	type SpawnOptions,
	type SpawnResult,
} from "./clone.ts";
export {
	DEFAULT_PROJECTS_DIR,
	defaultProjectsRoot,
	type EnvLike,
	loadProjectsConfigFromEnv,
	type ProjectsConfig,
} from "./config.ts";
export { ProjectUnavailableError } from "./errors.ts";
export {
	type AddProjectInput,
	addProject,
	type DeleteProjectInput,
	deleteProject,
	getProject,
	listProjects,
	type RefreshProjectInput,
	type RefreshProjectResult,
	refreshProject,
} from "./manage.ts";
export {
	type RefreshProjectCloneInput,
	type RefreshProjectCloneResult,
	refreshProjectClone,
} from "./refresh.ts";
export { type ParsedGitHubUrl, parseGitHubUrl } from "./url.ts";

/**
 * Public re-exports for the project-management module. Internal modules
 * import from here so file layout under `projects/` can shift without
 * rippling out to call sites.
 */

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
	type EnvLike,
	loadProjectsConfigFromEnv,
	type ProjectsConfig,
} from "./config.ts";
export { ProjectUnavailableError, TargetProjectUnresolvedError } from "./errors.ts";
export {
	type AddProjectInput,
	addProject,
	type DeleteProjectInput,
	deleteProject,
	listProjects,
	type RefreshProjectInput,
	type RefreshProjectResult,
	refreshProject,
} from "./manage.ts";
export {
	detectProjectFeatures,
	PROJECT_FEATURE_DIRS,
	type ProjectFeatureFlags,
	type RefreshProjectCloneInput,
	type RefreshProjectCloneResult,
	refreshProjectClone,
} from "./refresh.ts";
export {
	type ResolveTargetRepos,
	resolveTargetProject,
} from "./resolve-target.ts";
export { type ParsedGitHubUrl, parseGitHubUrl } from "./url.ts";

/**
 * Public re-exports for the canopy agent registry. Internal modules
 * import from here so the file layout under `registry/` can shift
 * without rippling out to call sites.
 */

export {
	type AgentSource,
	type AgentSourceTier,
	agentSourceTier,
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENT_SOURCE,
	BUILTIN_AGENTS,
	type BuiltinAgentSource,
	CLAUDE_CODE_BUILTIN,
	isProjectAgentSource,
	LIBRARY_AGENT_SOURCE,
	type LibraryAgentSource,
	makeProjectAgentSource,
	PROJECT_AGENT_SOURCE_PREFIX,
	type ProjectAgentSource,
	projectIdFromAgentSource,
	readAgentSource,
	SAPLING_BUILTIN,
	type SeedBuiltinAgentsResult,
	seedBuiltinAgents,
	stampAgentSource,
} from "./builtins/index.ts";
export {
	type AgentSummary,
	CanopyClient,
	type CanopyClientOptions,
	type CanopyClientProjectOptions,
	DEFAULT_CANOPY_TIMEOUT_MS,
	type SpawnFn,
	type SpawnOptions,
	type SpawnResult,
} from "./canopy.ts";
export { AgentSchemaError, CanopyUnavailableError } from "./errors.ts";
export {
	defaultRenderedCacheWriter,
	RENDERED_CACHE_SUBPATH,
	type RefreshProjectOptions,
	type RefreshProjectResult,
	type RefreshSkipped,
	type RenderedCacheWriter,
	refreshProjectAgents,
} from "./refresh.ts";
export {
	type AgentDefinition,
	parseRenderedAgent,
	REQUIRED_AGENT_SECTIONS,
	type RenderResponse,
	RenderResponseSchema,
	type RequiredAgentSection,
	readProviderFrontmatter,
} from "./schema.ts";

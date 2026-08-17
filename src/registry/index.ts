/**
 * Public re-exports for the agent registry. Internal modules import from
 * here so the file layout under `registry/` can shift without rippling
 * out to call sites.
 */

// Row type re-export at the domain seam (warren-02c9): the drizzle schema
// stays the source of the inferred type; handlers import `AgentDbRow` here.
export type { AgentDbRow } from "../db/schema.ts";
export {
	type AgentSource,
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENT_SOURCE,
	BUILTIN_AGENTS,
	type BuiltinAgentSource,
	CLAUDE_CODE_BUILTIN,
	LIBRARY_AGENT_SOURCE,
	type LibraryAgentSource,
	readAgentSource,
	type SeedBuiltinAgentsResult,
	seedBuiltinAgents,
	stampAgentSource,
} from "./builtins/index.ts";
export { AgentSchemaError } from "./errors.ts";
export {
	type AgentDefinition,
	parseRenderedAgent,
	REQUIRED_AGENT_SECTIONS,
	type RenderResponse,
	RenderResponseSchema,
	type RequiredAgentSection,
	readProviderFrontmatter,
} from "./schema.ts";

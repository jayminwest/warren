/**
 * Public re-exports for the per-project `.warren/` config module (R-02).
 * Internal modules import from here so file layout under `warren-config/`
 * can shift without rippling out to call sites.
 */

export {
	createWarrenConfigCache,
	type WarrenConfigCache,
	type WarrenConfigCacheOptions,
	type WarrenConfigLoader,
} from "./cache.ts";
export {
	WARREN_CONFIG_DIR,
	WARREN_CONFIG_FILES,
	type WarrenConfigFileKey,
	warrenConfigRelativePath,
} from "./config.ts";
export {
	WARREN_CONFIG_FILE_ERROR_CODES,
	type WarrenConfigFileError,
	type WarrenConfigFileErrorCode,
	WarrenConfigUnavailableError,
} from "./errors.ts";
export {
	type ExistsFn,
	type LoadedWarrenConfig,
	type LoadWarrenConfigInput,
	loadWarrenConfig,
	type ReadFileFn,
} from "./load.ts";
export {
	type AgentConfig,
	type CronTrigger,
	DEFAULT_AGENT_PAUSE_TIMEOUT_MS,
	DEFAULT_PREVIEW_MODE,
	type DefaultsConfig,
	DefaultsConfigSchema,
	type InteractiveAgentsConfig,
	interactiveRuntimeOverride,
	KNOWN_RUNTIME_IDS,
	type ParseResult,
	type PlotSyncConfig,
	type PlotSyncMergeStrategy,
	type PreviewConfig,
	PreviewConfigSchema,
	type PreviewMode,
	PreviewModeSchema,
	parseConfigFile,
	parseDefaultsConfig,
	parsePreviewFile,
	parseTriggersConfig,
	type RuntimeId,
	type ServerPreviewConfig,
	type StaticPreviewConfig,
	type Trigger,
	TriggerSchema,
	type TriggersConfig,
	TriggersConfigSchema,
} from "./schema.ts";

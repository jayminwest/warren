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
	WarrenConfigInvalidError,
	WarrenConfigUnavailableError,
} from "./errors.ts";
export {
	type ExistsFn,
	type LoadedWarrenConfig,
	type LoadWarrenConfigInput,
	loadWarrenConfig,
	type ReadFileFn,
} from "./load.ts";
// warren-653f: ephemeral-storage defaults sourced straight from resources-config
// (not routed through schema.ts) to keep that frozen-budget file unchanged.
export {
	DEFAULT_K8S_EPHEMERAL_STORAGE_LIMIT_MIB,
	DEFAULT_K8S_EPHEMERAL_STORAGE_REQUEST_MIB,
} from "./resources-config.ts";
export {
	type AgentConfig,
	type CronTrigger,
	DEFAULT_HEALER_COOLDOWN_MINUTES,
	DEFAULT_HEALER_MAX_RETRIES,
	DEFAULT_HEALER_ROLE,
	DEFAULT_K8S_CPU_LIMIT_MILLICORES,
	DEFAULT_K8S_CPU_REQUEST_MILLICORES,
	DEFAULT_K8S_MEMORY_LIMIT_MIB,
	DEFAULT_K8S_MEMORY_REQUEST_MIB,
	DEFAULT_K8S_NETWORK,
	DEFAULT_PREVIEW_MODE,
	type DefaultsConfig,
	DefaultsConfigSchema,
	type HealerConfig,
	type InteractiveAgentsConfig,
	interactiveRuntimeOverride,
	KNOWN_RUNTIME_IDS,
	type NetworkPolicy,
	NetworkPolicySchema,
	type ParseResult,
	type PreviewConfig,
	PreviewConfigSchema,
	type PreviewMode,
	PreviewModeSchema,
	parseConfigFile,
	parseDefaultsConfig,
	parsePreviewFile,
	parseTriggersConfig,
	type ResourcesConfig,
	type RuntimeId,
	type ServerPreviewConfig,
	type StaticPreviewConfig,
	type Trigger,
	TriggerSchema,
	type TriggersConfig,
	TriggersConfigSchema,
} from "./schema.ts";

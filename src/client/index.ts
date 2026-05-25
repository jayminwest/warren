/**
 * Public re-exports for the warren-client facade. Internal and external
 * modules can import from here so the file layout under `client/` can
 * move without touching call sites.
 */

export {
	DEFAULT_PROBE_TIMEOUT_MS,
	WarrenClient,
	type WarrenClientOptions,
} from "./client.ts";

export {
	DEFAULT_WARREN_BASE_URL,
	type EnvLike,
	loadWarrenClientConfigFromEnv,
	type WarrenClientConfig,
} from "./config.ts";

export {
	WarrenClientError,
	WarrenUnreachableError,
} from "./errors.ts";

export * from "./types.ts";

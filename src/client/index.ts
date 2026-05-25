/**
 * Public re-exports for the warren-client facade. Internal and external
 * modules can import from here so the file layout under `client/` can
 * move without touching call sites.
 */

export {
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_POLL_TIMEOUT_MS,
	DEFAULT_PROBE_TIMEOUT_MS,
	type WaitForRunOptions,
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

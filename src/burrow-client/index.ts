/**
 * Public re-exports for the burrow-client facade. Internal modules import
 * from here so the file layout under `burrow-client/` can move without
 * touching call sites.
 *
 * The multi-worker pool + fan-out layers were retired with the K8s migration
 * (warren-76c5): warren's self-host backend is a single local burrow, so this
 * facade now exposes one {@link BurrowClient} plus the vestigial
 * {@link LOCAL_WORKER_NAME} / {@link probeBurrowClient} helpers (see local.ts).
 */

export {
	BurrowClient,
	type BurrowClientOptions,
	DEFAULT_PROBE_TIMEOUT_MS,
	isTransportError,
	withTransportMapping,
} from "./client.ts";
export {
	type BurrowClientConfig,
	DEFAULT_BURROW_SOCKET,
	type EnvLike,
	loadBurrowClientConfigFromEnv,
} from "./config.ts";
export { BurrowUnreachableError } from "./errors.ts";
export { LOCAL_WORKER_NAME, type ProbeResult, probeBurrowClient } from "./local.ts";

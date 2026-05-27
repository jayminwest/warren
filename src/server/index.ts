/**
 * Public re-exports for the warren HTTP server. Internal modules and
 * the CLI import from here so the file layout under `server/` can shift
 * without rippling out to call sites.
 */

export { bearerAuth, NO_AUTH, type ResolveAuthOptions, resolveAuth } from "./auth.ts";
export {
	type BootBridgesResult,
	bootBridges,
	type CreateBridgeRegistryInput,
	createBridgeRegistry,
} from "./bridges.ts";
export {
	DEFAULT_BIND_HOST,
	DEFAULT_BIND_PORT,
	DEFAULT_DATA_DIR,
	type EnvLike,
	type LoadServerConfigOptions,
	loadServerConfigFromEnv,
	type ServerConfig,
} from "./config.ts";
export {
	methodNotAllowed,
	notFound,
	notImplemented,
	type RenderedError,
	renderError,
} from "./errors.ts";
export {
	API_PREFIXES,
	API_ROUTE_PATTERNS,
	buildApiRoutes,
	isApiPath,
	isAuthExempt,
} from "./handlers/index.ts";
export { type BootServerOptions, bootServer, type WarrenServerHandle } from "./main.ts";
export {
	DEFAULT_WORKER_PROBE_INTERVAL_MS,
	DEFAULT_WORKER_PROBE_TIMEOUT_MS,
	loadWorkerProbeConfigFromEnv,
	runProbeTick,
	startWorkerProbe,
	type WorkerProbeConfig,
	type WorkerProbeHandle,
	type WorkerProbeTickResult,
	type WorkerProbeTransition,
} from "./probe.ts";
export { jsonResponse, ndjsonResponse } from "./response.ts";
export { compilePattern, matchRoute, pathExists } from "./router.ts";
export { startServer } from "./server.ts";
export type {
	AuthDenied,
	AuthOk,
	AuthOutcome,
	AuthProvider,
	BridgeRegistry,
	ErrorEnvelope,
	HttpMethod,
	Logger,
	Route,
	RouteContext,
	RouteHandler,
	RoutePattern,
	ServeHandle,
	ServeOptions,
	ServerDeps,
	Transport,
} from "./types.ts";
export { createUiHandler, type UiHandlerOptions } from "./ui.ts";

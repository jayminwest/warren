/**
 * Public re-exports for the warren HTTP server. Internal modules and
 * the CLI import from here so the file layout under `server/` can shift
 * without rippling out to call sites.
 */

export {
	ANONYMOUS_ACTOR,
	AUTH_KINDS,
	type AuthEnv,
	type AuthKind,
	bearerAuth,
	DEFAULT_AUTH_KIND,
	NO_AUTH,
	OPERATOR_ACTOR,
	policyAllows,
	publicReadAuth,
	type ResolveAuthOptions,
	resolveAuth,
	resolveAuthKind,
	UnknownAuthProviderError,
} from "./auth.ts";
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
	forbidden,
	INTERNAL_ERROR_MESSAGE,
	methodNotAllowed,
	notFound,
	notImplemented,
	type RenderedError,
	renderError,
} from "./errors.ts";
export {
	API_PREFIXES,
	API_ROUTE_PATTERNS,
	API_ROUTE_POLICIES,
	buildApiRoutes,
	isApiPath,
	isAuthExempt,
} from "./handlers/index.ts";
export {
	type BootServerOptions,
	bootServer,
	type WarrenServerHandle,
} from "./main/index.ts";
export { jsonResponse, ndjsonResponse } from "./response.ts";
export { compilePattern, matchRoute, pathExists } from "./router.ts";
export { startServer } from "./server.ts";
export type {
	Actor,
	ActorCapabilities,
	ActorKind,
	AuthDenied,
	AuthOk,
	AuthOutcome,
	AuthProvider,
	BridgeRegistry,
	CapabilityName,
	ErrorEnvelope,
	HttpMethod,
	Logger,
	Route,
	RouteContext,
	RouteHandler,
	RoutePattern,
	RoutePolicy,
	ServeHandle,
	ServeOptions,
	ServerDeps,
	Transport,
} from "./types.ts";
export { createUiHandler, type UiHandlerOptions } from "./ui.ts";

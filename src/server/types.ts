/**
 * Shared types for the warren HTTP server (SPEC §8.1).
 *
 * The shape mirrors burrow's server (`@os-eco/burrow-cli` `src/server/`)
 * deliberately so a future operator who flips between the two can read
 * either codebase without retraining: same Route/RouteContext/ServeHandle
 * surface, same auth seam, same error envelope. Warren's HTTP face is
 * thin glue over the modules in `runs/`, `registry/`, `projects/`, and
 * `db/repos/` — this file just declares the seams the wiring rides on.
 */

import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { AnyWarrenDb } from "../db/client.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunPlotAppender } from "../plan-runs/plot-appender.ts";
import type { PreviewAuth } from "../preview/cookie.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import type { CanopyRegistryConfig } from "../registry/config.ts";
import type { RunEventBroker } from "../runs/events.ts";
import type { AutoOpenPrConfig } from "../runs/pr.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { PreviewMode, WarrenConfigCache } from "../warren-config/index.ts";

/**
 * Error envelope rendered for every non-2xx response. Mirrors burrow's
 * `ErrorEnvelope` so an HTTP consumer hitting both surfaces uses one
 * decoder. `code` is the stable machine identifier; `message` is human;
 * `hint` is the optional recovery cue from `WarrenError.recoveryHint`.
 */
export interface ErrorEnvelope {
	error: {
		code: string;
		message: string;
		hint?: string;
	};
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Compiled route pattern. `paramNames` is the ordered list of `:foo`
 * segments captured by `regex`; the router populates `RouteContext.params`
 * from this list at request time without re-parsing the pattern.
 */
export interface RoutePattern {
	method: HttpMethod;
	pattern: string;
	regex: RegExp;
	paramNames: readonly string[];
}

/**
 * Per-request context handed to route handlers. `params` carries the
 * decoded `:foo` captures. `logger` is whatever pino instance the server
 * was booted with; tests pass a silent one.
 */
export interface RouteContext {
	readonly request: Request;
	readonly url: URL;
	readonly params: Readonly<Record<string, string>>;
	readonly logger: Logger;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export interface Route {
	readonly method: HttpMethod;
	readonly pattern: string;
	readonly handler: RouteHandler;
}

/**
 * Wire-level binding for `warren serve`. TCP is the canonical V1 deploy
 * (warren is fronted by Caddy/Fly edge for TLS — see SPEC §11.D); the
 * unix socket option is kept for any future "warren next to a reverse
 * proxy on the same box without a port" deploy. Defaults to ephemeral
 * loopback TCP for tests.
 */
export type Transport =
	| { readonly kind: "unix"; readonly path: string }
	| { readonly kind: "tcp"; readonly hostname: string; readonly port: number };

/**
 * Pino-shaped logger. Loose enough that tests pass `console`-shaped
 * stubs and prod passes `pino()` without a type dance.
 */
export interface Logger {
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
	debug?(obj: object, msg?: string): void;
}

/**
 * Everything a handler needs to do its job. The server owns one of these
 * and threads it through to the route table; handlers never reach
 * outside this struct (so tests can swap any seam). `bridges` is the
 * per-server registry that owns the live `bridgeRunStream` controllers
 * — a fresh spawn registers one, shutdown aborts them all.
 */
export interface ServerDeps {
	readonly repos: Repos;
	/**
	 * Live db handle — used by the `/readyz` `db_reachable` probe
	 * (R-13 pl-f17e step 5, warren-e2ea) so the diagnostic envelope
	 * reports the active dialect. Tests can omit; the probe degrades
	 * to `ok: true` with a "no db wired" message when absent.
	 */
	readonly db?: AnyWarrenDb;
	/**
	 * Multi-worker burrow client pool (warren-39c3 / warren-c0c9 / pl-9ba1).
	 * Every burrow-targeting handler routes through this: `placeFor` for new
	 * burrows, `clientFor` for per-resource reads (cancel / steer / reap /
	 * bridges / GET /burrows/:id), and `probe()` for /readyz.
	 */
	readonly burrowClientPool: BurrowClientPool;
	readonly broker: RunEventBroker;
	readonly bridges: BridgeRegistry;
	/**
	 * Canopy library config — undefined when `CANOPY_REPO_URL` is unset
	 * (warren-d3e9). `POST /agents/refresh` and the canopy clone /
	 * canopy clean readyz probes are gated on this being defined.
	 * Built-in agents in `src/registry/builtins/` cover the common
	 * "no library configured" case.
	 */
	readonly canopyConfig?: CanopyRegistryConfig;
	readonly projectsConfig: ProjectsConfig;
	readonly logger: Logger;
	/** UI dist directory for static serving; null disables `/` and `/assets/*`. */
	readonly uiDistDir: string | null;
	/**
	 * Spawn seam used by `/readyz` (Phase 13 bwrap + canopy_clean probes)
	 * and any future shell-out from a handler. `main.ts` wires the
	 * production `Bun.spawn` adapter; tests pass a stub.
	 */
	readonly spawn?: SpawnFn;
	/**
	 * Seeds CLI deps (pl-bb70 step 4, warren-46cd). Threaded into `spawnRun`
	 * so a successful manual dispatch with `seedId` stamps the seed's
	 * warren-namespaced extensions (`role`, `trigger`, `lastRunId`,
	 * `lastRunAt`). `bootServer` builds this from `WARREN_SD_BINARY` +
	 * `defaultSpawn`; tests can omit (extension write is a no-op).
	 */
	readonly seedsCli?: SeedsCliDeps;
	/** Provided so tests can override `Date.now()`. */
	readonly now?: () => Date;
	/**
	 * Auto-open-PR config (warren-f6af). Threaded into the cancel handler
	 * so a graceful cancel that reaps inline still gets the same PR
	 * behavior as the bridge's terminal-detect reap path. `bootServer`
	 * resolves it from env via `loadAutoOpenPrConfigFromEnv`.
	 */
	readonly autoOpenPr?: AutoOpenPrConfig;
	/**
	 * Per-project `.warren/` config cache (R-02, pl-5d74 step 3). The
	 * project HTTP handlers invalidate this on refresh + delete so any
	 * subsequent reader re-parses against the post-lifecycle state.
	 * `bootServer` always wires a fresh cache; tests may omit.
	 */
	readonly warrenConfigs?: WarrenConfigCache;
	/**
	 * Deployment-wide run-branch prefix fallback (warren-9993). Resolved
	 * from `WARREN_RUN_BRANCH_PREFIX` at boot and threaded into every
	 * `spawnRun` call so a per-project default in `.warren/defaults.json`
	 * still wins. Unset → spawnRun falls back to "burrow".
	 */
	readonly runBranchPrefixDefault?: string;
	/**
	 * Preview port allocator range (R-19 / SPEC §11.L, warren-2277).
	 * Resolved from `WARREN_PREVIEW_PORT_RANGE` at boot so `/readyz`'s
	 * `preview_port_allocator` saturation probe matches what the reap-time
	 * launcher allocates against. Tests may omit; the probe degrades to
	 * an informational `ok: true`.
	 */
	readonly previewPortRange?: { readonly start: number; readonly end: number };
	/**
	 * Live-preview cap (R-19 / SPEC §11.L, warren-ea6b). Resolved from
	 * `WARREN_PREVIEW_MAX_LIVE` at boot so `/readyz`'s `preview_max_live`
	 * saturation probe matches the eviction worker's LRU cap. Tests may
	 * omit; the probe falls back to `DEFAULT_MAX_LIVE` so the codepath
	 * still exercises.
	 */
	readonly previewMaxLive?: number;
	/**
	 * Operator's preview host suffix (R-19 / SPEC §11.L, warren-8a10).
	 * Resolved at boot from `WARREN_PREVIEW_HOST`. In subdomain mode the
	 * Host-match preview proxy preamble requires this; in path mode it
	 * stays optional (previews ride on the warren host itself). Undefined
	 * + subdomain mode → preview surface is off, the login handler returns
	 * 400, and the proxy never inspects a request.
	 */
	readonly previewHost?: string;
	/**
	 * Preview routing mode (warren-edff / SPEC §11.L path addendum).
	 * Drives the login handler's redirect validation: subdomain mode
	 * targets `https://run-<id>.<host>/`; path mode targets the inbound
	 * origin under `/p/<id>/`. Defaults to `subdomain` so legacy callers
	 * that wire `previewAuth` without setting a mode keep their old
	 * semantics; `bootServer` always sets this.
	 */
	readonly previewMode?: PreviewMode;
	/**
	 * Signed-cookie auth for the preview proxy (R-19 / SPEC §11.L,
	 * warren-8a10). Bound at boot from `WARREN_API_TOKEN` (the same
	 * bearer the rest of warren uses). Undefined when the operator
	 * disabled the preview surface (subdomain mode with no host) or
	 * warren booted with `--no-auth`.
	 */
	readonly previewAuth?: PreviewAuth;
	/**
	 * Test seam for the `plan_run_dispatched` Plot append in the POST
	 * /plan-runs handler (warren-b89f / pl-7937 step 4). Production omits
	 * this; the handler falls back to `defaultPlanRunPlotAppender`, which
	 * opens a `UserPlotClient` against `<project>/.plot/` and best-effort
	 * appends one event. Tests substitute a stub to assert payload shape
	 * without touching disk.
	 */
	readonly planRunPlotAppender?: PlanRunPlotAppender;
	/**
	 * Server-side Plot aggregator (warren-c167 / pl-9d6a step 2). Used by
	 * `GET /plots` to fan out `UserPlotClient.query` across every
	 * `hasPlot=true` project, with a 5s in-memory cache and the
	 * empty-deployments byte-identical contract (see
	 * `src/plots/aggregate.ts`). `bootServer` always wires the default
	 * factory; tests stub the seam in `src/plots/aggregate.ts` and inject a
	 * custom aggregator here. When undefined the handler returns
	 * `EMPTY_PLOT_SUMMARIES` so a non-Plot deployment still sees a stable
	 * 200/`[]` response.
	 */
	readonly plotAggregator?: import("../plots/index.ts").PlotAggregator;
	/**
	 * Server-side Plot creator (warren-194e / pl-9d6a step 3). Used by
	 * `POST /plots` to open a `UserPlotClient` against the target
	 * project's `.plot/`, call `PlotStore.create({name})`, optionally
	 * apply an initial intent patch via `editIntent`, and return the
	 * fresh `PlotSummary` subset. Failure surfaces synchronously (the
	 * user is waiting on the result — see seed body). `bootServer`
	 * always wires the default; tests substitute a stub to assert
	 * payload shape without touching disk. When undefined the handler
	 * falls back to `defaultPlotCreator`.
	 */
	readonly plotCreator?: import("../plots/index.ts").PlotCreator;
	/**
	 * Server-side Plot reader (warren-961e / pl-9d6a step 8). Used by
	 * `GET /plots/:id` to open a `UserPlotClient` against the owning
	 * project's `.plot/`, snapshot the Plot + its event log, and return
	 * the full envelope (`{id, name, status, intent, attachments[],
	 * event_log[]}` — `project_id` is stitched on by the handler from
	 * the resolved `ProjectRow`). `bootServer` always wires the default;
	 * tests substitute a stub to assert payload shape without touching
	 * disk. When undefined the handler falls back to `defaultPlotReader`.
	 */
	readonly plotReader?: import("../plots/index.ts").PlotReader;
	/**
	 * Server-side Plot resolver (warren-961e / pl-9d6a step 8). Used by
	 * every per-Plot handler (`GET /plots/:id` and the mutation handlers
	 * landing later in pl-9d6a) to find the project owning a given
	 * `plot_id`. `bootServer` wires `createPlotResolver` backed by the
	 * same `plotAggregator` cache; tests substitute a stub to short-circuit
	 * the project lookup. When undefined the handler returns 404 so the
	 * empty-deployments contract stays stable.
	 */
	readonly plotResolver?: import("../plots/index.ts").PlotResolver;
}

/**
 * The bridge registry. Per-run bridges are created when `POST /runs`
 * lands and on warren startup via `recoverActiveRunStreams`; the
 * registry tracks them so server shutdown can abort everyone in one
 * pass. Concrete impl lives in `./bridges.ts`.
 */
export interface BridgeRegistry {
	/**
	 * Start a bridge for the given run; idempotent against a running bridge.
	 * `burrowId` is required so the bridge can resolve the owning worker via
	 * `BurrowClientPool.clientFor` (warren-c0c9).
	 */
	start(runId: string, burrowRunId: string, burrowId: string): void;
	/** Abort all in-flight bridges and await their drain. */
	stopAll(): Promise<void>;
	/** Test/diagnostic surface — number of currently-attached bridges. */
	size(): number;
}

export interface ServeOptions {
	transport?: Transport;
	/** Auth strategy. Defaults to `NO_AUTH` for tests; main wires `bearerAuth`. */
	auth?: AuthProvider;
	/** Override the route table (tests); defaults to `buildRoutes(deps)`. */
	routes?: readonly Route[];
	logger?: Logger;
	/**
	 * Per-request idle timeout in seconds passed to `Bun.serve`. Defaults
	 * to 0 (disabled) so long-lived NDJSON streams aren't killed at the
	 * Bun runtime default of 10s (warren-b8fc). Tests override to assert
	 * the wire is plumbed.
	 */
	idleTimeout?: number;
	/**
	 * Host-match preview proxy preamble (R-19 / SPEC §11.L, warren-8a10).
	 * Runs BEFORE auth + route match. Returns a `Response` to short-circuit
	 * the request, or `null` to fall through to the regular pipeline.
	 * Undefined → no preview surface (zero overhead per request).
	 */
	previewProxy?: PreviewProxyHandler;
}

/** Host-match preview proxy preamble. See `src/preview/proxy.ts`. */
export type PreviewProxyHandler = (request: Request, url: URL) => Promise<Response | null>;

export interface ServeHandle {
	readonly transport: Transport;
	readonly url: string;
	stop(): Promise<void>;
}

export interface AuthOk {
	readonly ok: true;
}

export interface AuthDenied {
	readonly ok: false;
	readonly status: number;
	readonly code: string;
	readonly message: string;
	readonly challenge?: string;
}

export type AuthOutcome = AuthOk | AuthDenied;

export interface AuthProvider {
	authorize(request: Request): AuthOutcome;
}

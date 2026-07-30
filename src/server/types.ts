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

import type { AnyWarrenDb } from "../db/client.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PreviewAuth } from "../preview/cookie.ts";
import type { RunPreviewsRepo } from "../preview/eviction/types.ts";
import type { PreviewProxyHandler } from "../preview/proxy/types.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import type { refreshProject } from "../projects/manage.ts";
import type { RunEventBroker } from "../runs/events.ts";
import type { AutoOpenPrConfig } from "../runs/pr.ts";
import type { BridgeRegistry } from "../runs/stream/types.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { PreviewMode, WarrenConfigCache } from "../warren-config/index.ts";
import type { IdempotencyStore } from "./idempotency.ts";

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
	/**
	 * Per-request child logger pre-bound with `request_id` (warren-30af).
	 * Handlers should prefer this over `deps.logger` so every log line
	 * produced inside a request carries the correlation id that is also
	 * stamped into the response's `X-Request-ID` header.
	 */
	readonly logger: Logger;
	/**
	 * The correlation id stamped onto the outgoing response's
	 * `X-Request-ID` header (warren-30af / pl-7b06 step 19). Either
	 * the inbound header value (when well-formed) or a freshly minted
	 * UUID. Surfaced here so handlers that propagate the id into
	 * downstream calls (burrow, plot, etc.) don't have to re-parse it
	 * off the request.
	 */
	readonly requestId: string;
	/**
	 * Socket peer address from `Bun.serve`'s `server.requestIP` (warren-25f6),
	 * or undefined on a transport that has none (unix socket) and in tests that
	 * build a context by hand. Behind the canonical Caddy / Ingress deploy this
	 * is the proxy, not the caller — `eventStreamClientKey` prefers
	 * `X-Forwarded-For` and only falls back here.
	 */
	readonly clientIp?: string;
	/**
	 * The authorized caller and its capability set (warren-1ff0), from the
	 * `AuthProvider` that admitted the request. Undefined on auth-exempt
	 * paths (`isAuthExempt`: `/healthz` plus every non-API path, where the
	 * gate never runs) and in tests that build a context by hand — every
	 * gated API route has one. Handlers should branch on
	 * `actor.capabilities.*`, never on `actor.kind`.
	 */
	readonly actor?: Actor;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export interface Route {
	readonly method: HttpMethod;
	readonly pattern: string;
	/**
	 * What the route demands of its caller (warren-b875). Enforced ONCE, in
	 * `handleRequest` — handlers never re-check. Required, so a route added
	 * without a declared policy is a typecheck failure rather than a
	 * silently-open surface.
	 */
	readonly policy: RoutePolicy;
	readonly handler: RouteHandler;
}

/**
 * Wire-level binding for `warren serve`. TCP is the canonical V1 deploy
 * (warren is fronted by Caddy / cluster ingress for TLS — see SPEC §11.D); the
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
	 * Live db handle — used by the `/readyz` `db_reachable` probe (R-13 pl-f17e
	 * step 5, warren-e2ea) so the diagnostic envelope reports the active dialect.
	 * Tests can omit; the probe degrades to `ok: true`/"no db wired" when absent.
	 */
	readonly db?: AnyWarrenDb;
	/**
	 * Drizzle adapter over `db`, built ONCE at boot (warren-89a6). Handlers are
	 * a thin surface over the domain: they consume this, they never call
	 * `DrizzleAdapter.for(deps.db)` per request — `check:layers` fails the build
	 * if one does. Present exactly when `db` is; tests that wire neither keep
	 * the handlers' existing degraded paths.
	 */
	readonly dbAdapter?: DrizzleAdapter;
	/**
	 * Dialect-polymorphic run-previews repo over `db`, built ONCE at boot
	 * (warren-89a6). Same rule as `dbAdapter`: the preview-teardown handler and
	 * the `/readyz` preview probes consume it instead of calling
	 * `createRunPreviewsRepo(deps.db)` on every request.
	 */
	readonly runPreviews?: RunPreviewsRepo;
	/** Boot-resolved runtime provider (`resolveRuntimeProvider`, honoring
	 * `WARREN_RUNTIME`). REQUIRED (warren-f796) — handlers route through it, no
	 * burrow-client fallback (`local` ⇒ LocalProvider, `k8s` ⇒ K8sProvider). */
	readonly runtimeProvider: RuntimeProvider;
	/** Local-topology `/readyz` burrow probe (warren-f796), boot-wired by the `LocalBootBackend`; absent under `k8s`. */
	readonly burrowProbe?: () => Promise<import("../diagnostics/checks.ts").DiagnosticCheck>;
	/** Preview sidecar resolver (warren-e24d), gated on `previewPorts`. The local
	 * backend's combined facade resolver satisfies both preview consumer seams. */
	readonly previewSidecars?: import("../runtime/local/preview/sidecars.ts").LocalSidecarsResolver;
	/** K8s in-pod finalize correlation registry (warren-0d35); defaults to the
	 * shared singleton, so prod needs no wiring — tests inject a private instance. */
	readonly finalizeCoordinator?: import("../runtime/k8s/finalize-coordinator.ts").FinalizeCoordinator;
	readonly broker: RunEventBroker;
	readonly bridges: BridgeRegistry;
	readonly projectsConfig: ProjectsConfig;
	readonly logger: Logger;
	/** UI dist directory for static serving; null disables `/` and `/assets/*`. */
	readonly uiDistDir: string | null;
	/**
	 * Spawn seam used by `/readyz` (Phase 13 bwrap probe)
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
	 * saturation probe matches the eviction worker's LRU cap. Tests may omit; the
	 * probe falls back to `DEFAULT_MAX_LIVE` so the codepath still exercises.
	 */
	readonly previewMaxLive?: number;
	/**
	 * Fallback workspace-GC TTL in ms (warren-0a9a). Resolved from
	 * `WARREN_WORKSPACE_GC_TTL` at boot so `/readyz`'s `stale_burrow_workspaces`
	 * probe ages burrows on the GC sweeper's threshold. Tests may omit; the probe
	 * is skipped when absent.
	 */
	readonly workspaceGcTtlMs?: number;
	/**
	 * Operator's preview host suffix (R-19 / SPEC §11.L, warren-8a10).
	 * Resolved at boot from `WARREN_PREVIEW_HOST`. In subdomain mode the
	 * Host-match preview proxy preamble requires this; in path mode it stays
	 * optional (previews ride on the warren host itself). Undefined + subdomain
	 * mode → preview surface off, the login handler 400s, the proxy never inspects.
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
	 * Project host-clone refresher (warren-6d60). Used by the plan-run
	 * dispatch handlers (`refreshDispatchProject`) so the seeds plan is
	 * read off a freshly fetched + reset clone, mirroring the single-run
	 * path's `spawnRun` refresh. Production omits this (falls back to the
	 * live `refreshProject` when `spawn` is wired); tests substitute a
	 * stub so they never shell out to git.
	 */
	readonly refreshProjectFn?: typeof refreshProject;
	/**
	 * `POST /runs` idempotency window (warren-d525). When wired, a dispatch
	 * carrying an `Idempotency-Key` header is deduped per `(projectId, key)`
	 * so a duplicate delivery replays the original 201 instead of spawning
	 * a second run. `bootServer` always wires a default; tests may omit (a
	 * dispatch without the header is unaffected either way, and one with
	 * the header simply isn't deduped). See `src/server/idempotency.ts`.
	 */
	readonly idempotencyStore?: IdempotencyStore;
	/**
	 * Counter registry for `GET /metrics` (observability Phase 1); undefined omits the counters.
	 */
	readonly metricsRegistry?: import("../observability/metrics-registry.ts").MetricsRegistry;
	/**
	 * K8s pod-phase gauge source for `GET /metrics` (pl-829f step 16); set under WARREN_RUNTIME=k8s.
	 */
	readonly podMetrics?: import("../runtime/k8s/pod-metrics.ts").PodMetricsSource;
	/**
	 * Concurrency admission for the two NDJSON event-stream routes
	 * (warren-25f6). `bootServer` always wires one from
	 * `loadEventStreamLimitsFromEnv()`; tests may omit, in which case the
	 * streams are uncapped. Also feeds the `warren_event_streams` gauge on
	 * `GET /metrics`. See `src/server/stream-limits.ts`.
	 */
	readonly streamLimiter?: import("./stream-limits.ts").EventStreamLimiter;
	/**
	 * What `POST /projects` may register (warren-ce9b, widened to repo
	 * granularity by warren-1841): bare owners and/or `owner/repo` pairs.
	 * `bootServer` wires this ONLY under `WARREN_AUTH=public`, from
	 * `WARREN_PUBLIC_ALLOWLIST`; absent (token mode, tests) ⇒ no
	 * restriction. See `src/server/public-allowlist.ts`.
	 */
	readonly publicAllowlist?: import("./public-allowlist.ts").PublicAllowlist;
}

/**
 * The bridge registry. Declared in the run-stream domain
 * (`src/runs/stream/types.ts`) alongside the bridge it registers, and
 * re-exported here for the server modules that consume it (warren-89a6).
 * Concrete impl lives in `./bridges.ts`.
 */
export type { BridgeRegistry };

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
	/**
	 * Liveness probe for run-scoped callback tokens (warren-57fd). Given a run
	 * id, resolves true while the run may still call back (non-terminal). The
	 * request gate uses it to reject a `run` actor once its run is terminal.
	 * `bootServer` wires it from `deps.repos.runs`; tests may omit (a run token
	 * is then bounded only by route+id, not by liveness).
	 */
	runActivityCheck?: RunActivityCheck;
}

/**
 * Resolves true while `runId` may still legitimately call back into warren
 * (i.e. it is not terminal). See `ServeOptions.runActivityCheck`.
 */
export type RunActivityCheck = (runId: string) => Promise<boolean>;

/**
 * Host-match preview proxy preamble. Declared in the preview domain
 * (`src/preview/proxy/types.ts`) and re-exported here for the server wiring
 * that consumes it (warren-89a6).
 */
export type { PreviewProxyHandler };

export interface ServeHandle {
	readonly transport: Transport;
	readonly url: string;
	stop(): Promise<void>;
}

/**
 * What a caller is permitted to do — the gate branches on these, it does
 * not re-derive them from who the caller is (warren-1ff0). Named for the
 * permission, not the holder, mirroring `RuntimeCapabilities`
 * (`src/runtime/contract.ts`): a flag says what the surface allows, so a
 * later provider can grant an arbitrary subset without anyone teaching
 * handlers a new identity vocabulary.
 */
export interface ActorCapabilities {
	/** Read the public projection of runs / projects / agents. */
	readonly readPublic: boolean;
	/**
	 * Read operator-only surfaces — diagnostics, the run inbox, cost
	 * rollups, raw agent transcripts, per-project warren-config.
	 */
	readonly readOperator: boolean;
	/** Dispatch runs / plan-runs and steer, pause, cancel them. */
	readonly dispatch: boolean;
	/** Mutate instance-level state — register projects, triggers, config. */
	readonly admin: boolean;
}

/**
 * One capability name. Derived from `ActorCapabilities` rather than
 * re-listed, so a capability added there is automatically a legal route
 * policy and the two vocabularies can't drift.
 */
export type CapabilityName = keyof ActorCapabilities;

/**
 * What a route demands of its caller (warren-b875). Every `ROUTE_TABLE`
 * entry declares exactly one; there is no default and no fallthrough.
 *
 * `anonymous` is the only value that isn't a capability: it means the auth
 * gate never runs for that path at all (`isAuthExempt` is derived from it),
 * so the route answers a credential-less caller in EVERY auth mode —
 * liveness probes and the version string the login screen reads before the
 * user has a token. Treat it as strictly wider than `readPublic`, which
 * still requires the bearer under the default `WARREN_AUTH=token`.
 *
 * Every other value names the capability the admitted actor must hold; the
 * gate refuses with 403 when it doesn't.
 */
export type RoutePolicy = "anonymous" | CapabilityName;

/**
 * Identity discriminant. `operator` is the single-user V1 caller (SPEC
 * §3.2 / §11.D) the token provider authorizes; `anonymous` is the
 * credential-less spectator the `WARREN_AUTH=public` provider mints
 * (warren-851b) — it holds `readPublic` and nothing else. `run` is a
 * sandbox calling back with its per-run scoped token (warren-57fd): it is
 * pinned to a single run's callback surface by the request gate, not by
 * its capability set. Further kinds land with the providers that mint them.
 */
export type ActorKind = "operator" | "anonymous" | "run";

/**
 * Who is making the request and what they may do. Produced by an
 * `AuthProvider`, carried on `RouteContext.actor` so a handler consults
 * capabilities instead of re-reading the Authorization header.
 */
export interface Actor {
	readonly kind: ActorKind;
	readonly capabilities: ActorCapabilities;
	/**
	 * The run a `run`-kind actor is scoped to (warren-57fd). Present ONLY on
	 * `kind === "run"`. The request gate refuses any route outside that run's
	 * callback surface, pins the `:id` param to this value, and rejects once
	 * the run is terminal — the capability set alone does not constrain it.
	 */
	readonly runId?: string;
}

export interface AuthOk {
	readonly ok: true;
	/** The authorized caller. Threaded onto `RouteContext.actor`. */
	readonly actor: Actor;
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

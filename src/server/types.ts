/**
 * Shared types for the warren HTTP server (docs/http-api.md).
 *
 * The shape mirrors burrow's server (`@os-eco/burrow-cli` `src/server/`)
 * deliberately so a future operator who flips between the two can read
 * either codebase without retraining: same Route/RouteContext/ServeHandle
 * surface, same auth seam, same error envelope. Warren's HTTP face is
 * thin glue over the modules in `runs/`, `registry/`, `projects/`, and
 * `db/repos/` — this file just declares the seams the wiring rides on.
 */

import type { ActorCapabilities, ActorKind, CapabilityName } from "../core/wire.ts";
import type { AnyWarrenDb } from "../db/client.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import type { Repos } from "../db/repos/index.ts";
import type { Forge } from "../forge/contract.ts";
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
 * Error envelope rendered for every non-2xx response. Defined once in
 * `src/core/wire.ts` (warren-42f1) and re-exported here so the server's
 * import surface is unchanged. Never redeclare it — `check:wire-types`
 * fails the build if you do.
 */
export type { ErrorEnvelope } from "../core/wire.ts";

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
 * (warren is fronted by Caddy / cluster ingress for TLS — see SECURITY.md); the
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
	/**
	 * Boot-resolved forge (`resolveForge` in `src/forge/registry.ts`, honoring
	 * `WARREN_FORGE`), resolved ONCE in `bootServer` (warren-6c4c) and threaded
	 * here exactly like `runtimeProvider`. REQUIRED. Handlers mint per-spawn git
	 * credentials through it (`mintGitCredential`); the handle must never
	 * appear in a public projection.
	 */
	readonly forge: Forge;
	/**
	 * Boot-resolved existence gate for the `/github-app/*` registration
	 * surface (warren-e320, `resolveGitHubAppRegistrationGate`). Gated-off
	 * routes answer 404. OPTIONAL: a test that omits it keeps the historical
	 * always-on behavior; `bootServer` always wires the resolved verdict.
	 */
	readonly gitHubAppRegistration?: import("./github-app-gate.ts").GitHubAppRegistrationGate;
	/**
	 * Opt-in GitHub App credential store + hot forge activation seam
	 * (warren-b504, `WARREN_APP_CRED_STORE=data-dir`). Absent (the
	 * default) keeps the historical render-once registration flow.
	 */
	readonly gitHubAppActivation?: import("../forge/hot-forge.ts").GitHubAppActivation;
	/** warren-48f8: armed setup-handoff store; absent ⇒ GET /setup answers 404. */
	readonly setupHandoff?: import("./setup-handoff.ts").SetupHandoffStore;
	/** K8s-topology `/readyz` sync seam (warren-39e1), boot-wired from the started
	 * pod-watcher under `WARREN_RUNTIME=k8s`; absent under `local`. */
	readonly k8sPodSync?: import("../runtime/k8s/pod-watcher.ts").PodSyncSource;
	/** Preview sidecar resolver (warren-e24d), gated on `previewPorts`. The local
	 * backend's combined facade resolver satisfies both preview consumer seams. */
	readonly previewSidecars?: import("../runtime/local/preview/sidecars.ts").LocalSidecarsResolver;
	/** K8s in-pod finalize correlation registry (warren-0d35); defaults to the
	 * shared singleton, so prod needs no wiring — tests inject a private instance. */
	readonly finalizeCoordinator?: import("../runtime/k8s/finalize-coordinator.ts").FinalizeCoordinator;
	/**
	 * K8s finalize-intent recovery hook (warren-5202). Fired by
	 * `GET /runs/:id/finalize-intent` on an intent MISS so a post-restart
	 * control plane re-drives reap for a pod still awaiting its intent.
	 * Boot-wired only under `WARREN_RUNTIME=k8s`; absent under `local` (no pod
	 * ever polls the route there) and in tests that don't opt in.
	 */
	readonly finalizeRecovery?: import("../runs/finalize-recovery.ts").FinalizeRecoveryHook;
	/**
	 * Durable salvage-bundle directory (warren-cd3b). The `POST /runs/:id/salvage`
	 * intake writes pod-captured git bundles here (`<runId>.bundle`); boot wires
	 * `<dataDir>/salvage`. Absent ⇒ the intake refuses with a 500 rather than
	 * silently dropping the run's only recoverable copy.
	 */
	readonly salvageDir?: string;
	readonly broker: RunEventBroker;
	/**
	 * Global lifecycle notification broker (warren-f566), built ONCE at boot
	 * and fed by a Tier-1 bus extension registered in the same
	 * `bootLifecycleBus` batch as the healer / seed-close consumers. Serves
	 * `GET /events/stream`. Optional: a test omitting it gets a 501 instead
	 * of a dangling open connection.
	 */
	readonly lifecycleStream?: import("../runs/lifecycle-stream.ts").LifecycleStreamBroker;
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
	 * Platform seam for the `/readyz` bwrap probe. Production omits it
	 * (`checkBwrap` reads `process.platform`); tests force `"linux"` so
	 * the probe path runs identically on macOS dev machines.
	 */
	readonly platform?: NodeJS.Platform;
	/**
	 * Seeds CLI deps (pl-bb70 step 4, warren-46cd). Threaded into `spawnRun`
	 * so a successful manual dispatch with `seedId` stamps the seed's
	 * warren-namespaced extensions (`role`, `trigger`, `lastRunId`,
	 * `lastRunAt`). `bootServer` builds this from `WARREN_SD_BINARY` +
	 * `defaultSpawn`; tests can omit (extension write is a no-op).
	 */
	readonly seedsCli?: SeedsCliDeps;
	/**
	 * The boot-resolved IssueTracker (warren-5819, plan pl-a37b Track B
	 * step 7). Constructed once at boot — a `SeedsTracker` wrapping the
	 * same `WARREN_SD_BINARY` + `defaultSpawn` pair `seedsCli` uses — and
	 * threaded through the same pass-through seams. Call sites still read
	 * the facade (`deps.seedsCli`); the port to the tracker contract lands
	 * in warren-2d98 / warren-47b0 / warren-6234, which delete `seedsCli`
	 * once no consumer remains. Tests may omit.
	 */
	readonly issueTracker?: import("../tracker/contract.ts").IssueTracker;
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
	 * still wins. Unset → spawnRun falls back to the built-in default ("warren").
	 */
	readonly runBranchPrefixDefault?: string;
	/**
	 * Preview port allocator range (R-19 / docs/design/preview-environments.md, warren-2277).
	 * Resolved from `WARREN_PREVIEW_PORT_RANGE` at boot so `/readyz`'s
	 * `preview_port_allocator` saturation probe matches what the reap-time
	 * launcher allocates against. Tests may omit; the probe degrades to
	 * an informational `ok: true`.
	 */
	readonly previewPortRange?: { readonly start: number; readonly end: number };
	/**
	 * Live-preview cap (R-19 / docs/design/preview-environments.md, warren-ea6b). Resolved from
	 * `WARREN_PREVIEW_MAX_LIVE` at boot so `/readyz`'s `preview_max_live`
	 * saturation probe matches the eviction worker's LRU cap. Tests may omit; the
	 * probe falls back to `DEFAULT_MAX_LIVE` so the codepath still exercises.
	 */
	readonly previewMaxLive?: number;
	/**
	 * Fallback workspace-GC TTL in ms (warren-0a9a). Resolved from
	 * `WARREN_WORKSPACE_GC_TTL` at boot so `/readyz`'s `stale_sandbox_workspaces`
	 * probe ages burrows on the GC sweeper's threshold. Tests may omit; the probe
	 * is skipped when absent.
	 */
	readonly workspaceGcTtlMs?: number;
	/**
	 * Operator's preview host suffix (R-19 / docs/design/preview-environments.md, warren-8a10).
	 * Resolved at boot from `WARREN_PREVIEW_HOST`. In subdomain mode the
	 * Host-match preview proxy preamble requires this; in path mode it stays
	 * optional (previews ride on the warren host itself). Undefined + subdomain
	 * mode → preview surface off, the login handler 400s, the proxy never inspects.
	 */
	readonly previewHost?: string;
	/**
	 * Preview routing mode (warren-edff / docs/design/preview-environments.md path addendum).
	 * Drives the login handler's redirect validation: subdomain mode
	 * targets `https://run-<id>.<host>/`; path mode targets the inbound
	 * origin under `/p/<id>/`. Defaults to `subdomain` so legacy callers
	 * that wire `previewAuth` without setting a mode keep their old
	 * semantics; `bootServer` always sets this.
	 */
	readonly previewMode?: PreviewMode;
	/**
	 * Public port of the dedicated path-mode preview listener
	 * (warren-3f8a). Path-mode previews live on their own origin — same
	 * hostname as warren, this port — so the login handshake resolves
	 * redirects against it and `/preview/config` discloses it to the UI.
	 * Undefined in subdomain mode, on the unix transport's legacy
	 * same-origin mounting, and in tests that never boot the listener
	 * (redirects then resolve against the inbound origin, the pre-split
	 * behaviour).
	 */
	readonly previewPort?: number;
	/**
	 * Signed-cookie auth for the preview proxy (R-19 / docs/design/preview-environments.md,
	 * warren-8a10). Bound at boot from `WARREN_API_TOKEN` (the same
	 * bearer the rest of warren uses). Undefined when the operator
	 * disabled the preview surface (subdomain mode with no host) or
	 * warren booted with `--no-auth`.
	 */
	readonly previewAuth?: PreviewAuth;
	/**
	 * Project host-clone refresher (warren-6d60). Used by the plan-run
	 * creation orchestration (`createPlanRun`, warren-e240) so the seeds plan is
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
	 * restriction. See `src/projects/public-allowlist.ts`; enforced inside
	 * `addProject` (warren-0883).
	 */
	readonly publicAllowlist?: import("../projects/public-allowlist.ts").PublicAllowlist;
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
	 * Per-request idle timeout in seconds passed to `Bun.serve`. Defaults to
	 * `DEFAULT_IDLE_TIMEOUT_SECONDS`. The timer watches socket inactivity
	 * while a request is being read, so it bounds a stalled client without
	 * touching a long-lived NDJSON tail (warren-b8fc, warren-a676). 0
	 * disables it for the whole listener.
	 */
	idleTimeout?: number;
	/**
	 * Host-match preview proxy preamble (R-19 / docs/design/preview-environments.md, warren-8a10).
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
 * The actor vocabulary crosses the wire on `GET /whoami`, so it is declared
 * once in `src/core/wire.ts` (warren-3754) and re-exported here. Never
 * redeclare these — `check:wire-types` fails the build if you do.
 *
 * `ActorCapabilities` is named for the permission rather than the holder,
 * the way `RuntimeCapabilities` (`src/runtime/contract.ts`) is. That one
 * describes a sandbox and is a separate vocabulary.
 */
export type { ActorCapabilities, ActorKind, CapabilityName } from "../core/wire.ts";

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

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
import type { PlanSynthesizer } from "../plot-plan-runs/index.ts";
import type { PreviewAuth } from "../preview/cookie.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import type { CanopyRegistryConfig } from "../registry/config.ts";
import type { RunEventBroker } from "../runs/events.ts";
import type { AutoOpenPrConfig } from "../runs/pr.ts";
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
	 * Fallback workspace-GC TTL in ms (warren-0a9a). Resolved from
	 * `WARREN_WORKSPACE_GC_TTL` at boot so `/readyz`'s
	 * `stale_burrow_workspaces` probe ages burrows on the same threshold
	 * the GC sweeper uses. Tests may omit; the probe is skipped when
	 * absent.
	 */
	readonly workspaceGcTtlMs?: number;
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
	 * Plan-child adopter (warren-18a9). Used by `GET /plots/:id` to
	 * reconcile a Plot's `sd_plan` attachments (a `seeds_issue` whose
	 * `ref` is a `pl-*` plan id) with the children of the plans they
	 * reference: any plan child not already present as a `seeds_issue`
	 * attachment is auto-attached so the Plot's substrate panel stays in
	 * parity with the plan. Best-effort + fire-and-log — a reconciliation
	 * failure never breaks the read. Gated on `seedsCli` being wired and
	 * the owning project having `.seeds/`. When undefined the handler
	 * falls back to `defaultPlanChildAdopter`.
	 */
	readonly planChildAdopter?: import("../plots/index.ts").PlanChildAdopter;
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
	/**
	 * Server-side Plot intent editor (warren-896f / pl-9d6a step 9). Used
	 * by `POST /plots/:id/intent` to open a `UserPlotClient` against the
	 * owning project's `.plot/`, enforce SPEC §6's frozen-at-done rule,
	 * apply the patch via `PlotHandle.editIntent`, and return the fresh
	 * envelope subset (`{id, name, status, intent, attachments[],
	 * event_log[]}` — `project_id` is stitched on by the handler from
	 * the resolved `ProjectRow`). Failure surfaces synchronously (the
	 * user is waiting on the result — see seed body — so this is NOT
	 * fire-and-log, in contrast to `defaultPlanRunPlotAppender`).
	 * `bootServer` always wires the default; tests substitute a stub to
	 * assert payload shape without touching disk. When undefined the
	 * handler falls back to `defaultPlotIntentEditor`.
	 */
	readonly plotIntentEditor?: import("../plots/index.ts").PlotIntentEditor;
	/**
	 * Server-side Plot rename seam (warren-bed0 / pl-b0c0 step 3). Used by
	 * `POST /plots/:id/rename` to open a `UserPlotClient` against the
	 * owning project's `.plot/`, mutate `plot.json#/name` under the lib's
	 * per-Plot file lock via `UserPlotClient.rename` (which appends a
	 * `note` event recording the from→to transition), and return the fresh
	 * envelope subset. Failure surfaces synchronously (NOT fire-and-log
	 * — same posture as `plotIntentEditor` / `plotStatusChanger`). Renames
	 * are allowed in every status — the name is pure metadata, unlike the
	 * intent body which freezes at done/archived per SPEC §6. `bootServer`
	 * always wires the default; tests substitute a stub. When undefined
	 * the handler falls back to `defaultPlotRenamer`.
	 */
	readonly plotRenamer?: import("../plots/index.ts").PlotRenamer;
	/**
	 * Server-side Plot status changer (warren-e868 / pl-9d6a step 10). Used
	 * by `POST /plots/:id/status` to open a `UserPlotClient` against the
	 * owning project's `.plot/`, enforce the SPEC §6.5 transition matrix
	 * (defense-in-depth on top of the handler-edge check), call
	 * `PlotHandle.setStatus`, and return the fresh summary subset +
	 * emitted `status_changed` event. Failure surfaces synchronously
	 * (NOT fire-and-log — same posture as `plotIntentEditor`).
	 * `bootServer` always wires the default; tests substitute a stub.
	 * When undefined the handler falls back to `defaultPlotStatusChanger`.
	 */
	readonly plotStatusChanger?: import("../plots/index.ts").PlotStatusChanger;
	/**
	 * Server-side Plot attach/detach seam (warren-589c / pl-9d6a step 11).
	 * Used by `POST /plots/:id/attachments` and
	 * `DELETE /plots/:id/attachments/:ref` to open a `UserPlotClient`
	 * against the owning project's `.plot/`, call
	 * `PlotHandle.attach` / `PlotHandle.detach`, and return the fresh
	 * envelope subset (`{id, name, status, intent, attachments[],
	 * event_log[]}` — plus `attachment` for attach, `removed_id` for
	 * detach). Failure surfaces synchronously (NOT fire-and-log — same
	 * posture as `plotIntentEditor` / `plotStatusChanger`).
	 * `bootServer` always wires the default; tests substitute a stub.
	 * When undefined the handler falls back to `defaultPlotAttacher`.
	 */
	readonly plotAttacher?: import("../plots/index.ts").PlotAttacher;
	/**
	 * Server-side Plot PR-merge seam (warren-8e39 / pl-0344 step 14).
	 * Used by `POST /plots/:id/attachments/:ref/merge` to resolve the
	 * `gh_pr` attachment by ref, call the GitHub merge REST API
	 * (`PUT /repos/:o/:r/pulls/:n/merge`), and return the fresh
	 * envelope subset plus the merge result variant. The handler
	 * schedules a follow-up `refreshProjectClone` on success so the
	 * local clone picks up the new merge commit. Failure surfaces
	 * synchronously (NOT fire-and-log — the user clicked the button).
	 * `bootServer` always wires the default; tests substitute a stub.
	 * When undefined the handler rejects with 503 so an unwired
	 * deployment doesn't silently swallow the click.
	 */
	readonly plotPrMerger?: import("../plots/index.ts").PlotPrMerger;
	/**
	 * Server-side Plot sync seam (warren-5bc2 / pl-5a6c).
	 * Used by `POST /plots/:id/sync` to check for dirty `.plot/` files,
	 * commit and push changes, and open/merge a PR.
	 */
	readonly plotSyncer?: import("../plots/index.ts").PlotSyncer;
	/**
	 * Server-side Plot question-answer seam (warren-e1ac / pl-9d6a step 12).
	 * Used by `POST /plots/:id/questions/:event_id/answer` to open a
	 * `UserPlotClient` against the owning project's `.plot/`, re-validate
	 * the handler-edge concurrency invariant (the targeted `question_posed`
	 * still exists and has no subsequent `question_answered`) against the
	 * fresh on-disk event log, append the `question_answered` event, and
	 * return the freshly appended event for optimistic UI splice. Failure
	 * surfaces synchronously (NOT fire-and-log — same posture as the
	 * intent/status/attach seams). `bootServer` always wires the default;
	 * tests substitute a stub. When undefined the handler falls back to
	 * `defaultPlotQuestionAnswerer`.
	 */
	readonly plotQuestionAnswerer?: import("../plots/index.ts").PlotQuestionAnswerer;
	/**
	 * Server-side Plot formalize seam (warren-d22e / pl-0344 step 8).
	 * Used by `POST /plots/:id/formalize` to extract a suggested intent
	 * (`{goal, non_goals, constraints, success_criteria}`) from the
	 * brainstorm conversation — every `agent_message` event across
	 * interactive runs bound to the Plot is parsed for field markers and
	 * folded into a single suggestion. The Plot is NOT mutated; the user
	 * accepts/edits via the existing `POST /plots/:id/intent` route.
	 * `bootServer` always wires the default; tests substitute a stub.
	 * When undefined the handler falls back to
	 * `createDefaultPlotFormalizer({repos})`.
	 */
	readonly plotFormalizer?: import("../plots/index.ts").PlotFormalizer;
	/**
	 * Server-side plot→plan-run synthesizer (warren-99b2 / pl-f404 step 3
	 * / SPEC §11.Q). `POST /plot-plan-runs` shells out via this seam to
	 * mint a fresh throwaway parent seed and a seeds plan whose children
	 * adopt the Plot's open `seeds_issue` attachments. `bootServer` wires
	 * `createDefaultPlanSynthesizer({ seedsCli })` when `seedsCli` is
	 * configured; tests substitute a stub to assert payload shape without
	 * shelling out. Undefined → the handler rejects with the same
	 * "seeds CLI not configured" error `POST /plan-runs` uses.
	 */
	readonly planSynthesizer?: PlanSynthesizer;
	/**
	 * `POST /runs` idempotency window (warren-d525). When wired, a dispatch
	 * carrying an `Idempotency-Key` header is deduped per `(projectId, key)`
	 * so a duplicate delivery replays the original 201 instead of spawning
	 * a second run. `bootServer` always wires a default; tests may omit (a
	 * dispatch without the header is unaffected either way, and one with
	 * the header simply isn't deduped). See `src/server/idempotency.ts`.
	 */
	readonly idempotencyStore?: IdempotencyStore;
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

/** Host-match preview proxy preamble. See `src/preview/proxy/index.ts`. */
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

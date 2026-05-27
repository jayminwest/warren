/**
 * Preview TTL + LRU eviction worker (R-19 / SPEC §11.L, warren-ea6b).
 * Split into `eviction/` modules in warren-d0a9 (pl-9088 step 8).
 *
 * Periodic tick that walks every preview in `starting`/`live` and evicts on
 * the four-signal contract from the design lock:
 *
 *   1. **Idle-TTL (primary).** Evicts when `now - preview_last_hit_at >
 *      idle_ttl`. Per-project override from `.warren/defaults.json`
 *      (`preview.idle_ttl`) takes precedence over the global env
 *      `WARREN_PREVIEW_IDLE_TTL` (default 30m). A preview that never got a
 *      proxy hit yet falls back to `preview_started_at` for the idle clock
 *      so a launched-but-never-visited preview still ages out.
 *
 *   2. **Max-lifetime ceiling.** Evicts when `now - preview_started_at >
 *      max_lifetime`. Same precedence: per-project override > global env
 *      `WARREN_PREVIEW_MAX_LIFETIME` (default 8h). Stops the "browser tab
 *      from yesterday auto-refreshing" failure mode that defeats idle-TTL
 *      alone.
 *
 *   3. **Global LRU cap.** After the per-row TTL pass, if the remaining
 *      live count still exceeds `WARREN_PREVIEW_MAX_LIVE` (default 20),
 *      evict the longest-idle previews until the count is back at the cap.
 *      Bounds container memory even when individual previews are within
 *      their TTLs. The `/readyz` saturation warning (>80% of cap) lives
 *      in `src/diagnostics/checks.ts`.
 *
 *   4. **Manual teardown.** Out of scope for this module — `POST
 *      /runs/:id/preview/teardown` (warren-d725) is the path. The worker
 *      filters on `preview_state IN ('starting','live')` so a row already
 *      transitioned to `torn-down` is naturally skipped on the next tick,
 *      and the per-row update re-reads state before writing to keep a
 *      racing manual-teardown idempotent at the SQL level.
 *
 * Module layout (warren-d0a9):
 *
 *   - `config.ts`   — env constants + parsers + `loadPreviewEvictionConfigFromEnv`
 *   - `types.ts`    — shared types (`RunPreviewRow`, `RunPreviewsRepo`,
 *                     `ManualTeardownClaim`, tick I/O, …)
 *   - `tick.ts`     — eviction strategy: `runPreviewEvictionTick` +
 *                     classify/apply helpers
 *   - `repo.ts`     — drizzle-backed `createRunPreviewsRepo` (lifecycle
 *                     persistence + manual-teardown CAS)
 *   - `sidecar.ts`  — pool-backed `createPoolSidecarResolver`
 *   - `worker.ts`   — periodic scheduler (`startPreviewEvictionWorker`)
 *
 * Public surface is re-exported here so call sites continue to import
 * from `../preview/eviction/index.ts` (or just `"../preview/eviction"`).
 */

export {
	DEFAULT_IDLE_TTL_MS,
	DEFAULT_MAX_LIFETIME_MS,
	DEFAULT_MAX_LIVE,
	DEFAULT_TICK_MS,
	type EnvLike,
	loadPreviewEvictionConfigFromEnv,
	PREVIEW_MAX_LIVE_WARN_RATIO,
	WARREN_PREVIEW_EVICTION_DISABLED_ENV,
	WARREN_PREVIEW_EVICTION_TICK_MS_ENV,
	WARREN_PREVIEW_IDLE_TTL_ENV,
	WARREN_PREVIEW_MAX_LIFETIME_ENV,
	WARREN_PREVIEW_MAX_LIVE_ENV,
} from "./config.ts";
export { createRunPreviewsRepo } from "./repo.ts";
export { createPoolSidecarResolver } from "./sidecar.ts";
export { runPreviewEvictionTick } from "./tick.ts";
export type {
	EvictionReason,
	ManualTeardownClaim,
	ManualTeardownStatus,
	PreviewEvictionConfig,
	PreviewEvictionLogger,
	PreviewEvictionTickInput,
	PreviewEvictionTickResult,
	RunPreviewRow,
	RunPreviewsRepo,
	SidecarClient,
	SidecarResolver,
} from "./types.ts";
export {
	type EvictionTimerHandle,
	type PreviewEvictionWorkerHandle,
	type StartPreviewEvictionWorkerInput,
	startPreviewEvictionWorker,
} from "./worker.ts";

/**
 * `spawnRun` — SPEC §4.3 composition flow (agent + project + prompt →
 * queued burrow run). Split into per-concern modules under warren-f71c /
 * pl-9088 step 6:
 *
 *   - `./dispatch.ts`         — `spawnRun` orchestrator + composers
 *   - `./plot-append.ts`      — `run_dispatched` Plot append (warren-e848)
 *   - `./seed-extensions.ts`  — post-dispatch seed extension write (pl-bb70)
 *   - `./agent-cache.ts`      — cached agent re-validation + override resolution
 *   - `./types.ts`            — `SpawnRunInput` / `SpawnRunResult` / appender shapes
 *
 * The full design rationale (placement, atomic seed payload, rollback
 * posture) lives at the top of `./dispatch.ts`.
 */

export { composeDispatchPrompt, spawnRun } from "./dispatch.ts";
export {
	DEFAULT_DISPATCHER_HANDLE,
	defaultPlotAppender,
	resolveDispatcherHandle,
} from "./plot-append.ts";
export type {
	AppendPlotRunDispatchedInput,
	SpawnPlotAppender,
	SpawnRunInput,
	SpawnRunResult,
} from "./types.ts";

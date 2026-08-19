/**
 * `spawnRun` — docs/design/agent-composition.md composition flow (agent + project + prompt →
 * queued burrow run). Split into per-concern modules under warren-f71c /
 * pl-9088 step 6:
 *
 *   - `./dispatch.ts`         — `spawnRun` orchestrator + composers
 *   - `./seed-extensions.ts`  — post-dispatch seed extension write (pl-bb70)
 *   - `./agent-cache.ts`      — cached agent re-validation + override resolution
 *   - `./types.ts`            — `SpawnRunInput` / `SpawnRunResult` / appender shapes
 *
 * The full design rationale (placement, atomic seed payload, rollback
 * posture) lives at the top of `./dispatch.ts`.
 */

export { composeDispatchPrompt, spawnRun } from "./dispatch.ts";
export type {
	JournalCollision,
	MigrationHealFn,
	MigrationHealInput,
	MigrationHealOutcome,
} from "./migration-preflight.ts";
export {
	healMigrationJournalCollisions,
	recordMigrationHealEvent,
} from "./migration-preflight.ts";
export type { DispatchOrigin, SpawnRunInput, SpawnRunResult } from "./types.ts";
export { DISPATCH_ORIGINS } from "./types.ts";

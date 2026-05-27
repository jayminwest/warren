/**
 * `reapRun` — SPEC §4.3 step 6 + §11.A.
 *
 * Once burrow says a run reached a terminal state, warren runs reap to
 * close out the run. Best-effort sub-steps run in order: mulch merge,
 * seeds-close mirror, plans mirror, plot merge, plot commit, seeds
 * commit, auto-plan-run dispatch, branch push, PR open, preview
 * launch, PR preview annotation. Then the warren run row transitions
 * to the burrow-observed outcome.
 *
 * Each sub-step lives in its own module under `src/runs/reap/`. See:
 *
 *   - `mulch.ts`        — mulch-expertise LWW merge
 *   - `seeds.ts`        — seeds close mirror + plans mirror
 *   - `plot-merge.ts`   — Plot events + state replay
 *   - `stage.ts`        — `.plot/` + `.seeds/` commit-through-reap
 *   - `auto-plan-run.ts`— auto-dispatch helper for agent-created plans
 *   - `pr-open.ts`      — auto-open PR (warren-f6af)
 *   - `preview.ts`      — preview launch + PR annotation (warren-f156)
 *   - `state.ts`        — failure-reason inference + terminal transition
 *   - `run.ts`          — top-level orchestrator
 *
 * Reap errors never fail the run — each sub-step is wrapped, and any
 * thrown error is recorded as a `reap_failed` event on the run with
 * the failing step name. The state transition still runs regardless,
 * so a reap failure cannot leave the warren row stuck in `running`.
 *
 * Idempotent: calling `reapRun` against a row already in a terminal
 * state is a no-op — useful for restart-recovery sweeps that re-issue
 * reap for runs that finalized in burrow while warren was offline.
 *
 * Every observable side effect (file IO, git push, system clock,
 * burrow client) is injectable so unit tests don't touch disk or shell.
 */

export { mergeMulchFile } from "./mulch.ts";
export { mergePlotEventsFile, mergePlotJsonFile } from "./plot-merge.ts";
export { reapRun } from "./run.ts";
export type {
	ReapExec,
	ReapFs,
	ReapRunInput,
	ReapRunResult,
	ReapStep,
	ReapStepError,
} from "./types.ts";

/**
 * Neutral home for the local-worker name (warren-e24d).
 *
 * The `runs.worker_id` column records which backend claimed a run. The
 * self-host burrow backend records it as `"local"`; the preview proxy keys its
 * cross-host deferral check off the same value. This constant lives here — a
 * domain module with no burrow coupling — so consumers (the preview subsystem)
 * don't have to reach into `src/burrow-client/` for a plain string, which would
 * re-couple a LocalProvider-only feature to the burrow dialect. `burrow-client`
 * re-exports this same constant so there is a single source of truth.
 */
export const LOCAL_WORKER_NAME = "local";

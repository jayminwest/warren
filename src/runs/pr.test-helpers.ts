/**
 * Canonical implementation moved to `src/forge/github/test-helpers.ts`
 * (plan pl-d1c9 step 1). This re-export keeps existing `src/runs/` test
 * imports resolving until those clients migrate in plan steps 2-5.
 */

export type { RecordedCall } from "../forge/github/test-helpers.ts";
export { jsonResponse, recordingFetch } from "../forge/github/test-helpers.ts";

/**
 * Per-delta noise classification for the event bridge. Moved out of
 * `./bridge.ts` in #1242 so the TurnMonitor (`./turn-monitor.ts`) could sit
 * at the same drop site without pushing the bridge over its file-size
 * ratchet.
 */

import type { StreamEventView } from "./types.ts";

/**
 * Per-delta noise envelopes the bridge deliberately does NOT persist
 * (warren event-volume incident, 2026-07-30; widened warren-ef12
 * 2026-07-31 after a post-fix audit showed ~75% of persisted rows per
 * run were still non-durable chatter).
 *
 * Dropped set — all are per-delta / skeleton envelopes whose durable
 * content is already stored elsewhere:
 *   - `message_update` (telemetry): pi emits one per model stream
 *     delta, each carrying the FULL cumulative message so far — on
 *     per-token streams (kimi-k3 via openrouter) thousands of rows per
 *     run growing quadratically in payload (a single run reached 12k+
 *     rows / ~50MB). The durable record is the `message_end` explosion
 *     into `text`/`thinking`/`tool_use` rows.
 *   - `tool_execution_update` (state_change): pi v0.74.0+ streams
 *     partial tool output (payload carries cumulative partialResult);
 *     unknown to burrow's parser it falls into the default
 *     `unknown -> state_change` branch. Same snapshot class as
 *     `message_update`; the final output is durably stored as
 *     `tool_result`.
 *   - `message_start`: an empty skeleton (content: [], stopReason
 *     pending, zeroed usage) that nothing reads.
 *
 * Deliberately KEPT: `turn_start`, `tool_execution_start` and
 * `tool_execution_end` are once-per-invocation lifecycle markers (not
 * per-delta), and `turn_end` MUST keep flowing — usage aggregation
 * (`src/runs/usage-aggregate.ts`) reads `state_change` `turn_end` (pi)
 * / `result` (claude-code) envelopes via `EventsRepo.listUsageEvents`
 * for cost/token totals; dropping it breaks usage. Other telemetry
 * subtypes (`queue_update`, `auto_retry_*`) are rare and meaningful.
 *
 * Nuance: dropping here means the UI never sees streaming partials; if
 * mid-run typing UX is ever wanted, the shape is
 * publish-but-dont-persist. The TurnMonitor (`./turn-monitor.ts`) now
 * reads these envelopes before the drop (#1242).
 */
const PER_DELTA_NOISE_TYPES = new Set(["message_update", "tool_execution_update", "message_start"]);

export function isPerDeltaNoiseEvent(event: StreamEventView): boolean {
	if (event.kind !== "telemetry" && event.kind !== "state_change") return false;
	const p = event.payload;
	if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
	const t = (p as { type?: unknown }).type;
	return typeof t === "string" && PER_DELTA_NOISE_TYPES.has(t);
}

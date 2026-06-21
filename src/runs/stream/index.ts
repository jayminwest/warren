/**
 * Bridge burrow's per-run event stream into warren's events table and
 * fan-out broker (SPEC §4.3 step 5, §9 "event durability rationale").
 *
 * The bridge is the only writer to `events` (rows always land via
 * `bridgeRunStream` → `EventsRepo.append`); the broker is published
 * to immediately after each row commits so live tailers see fresh
 * events without waiting on a polling interval.
 *
 * The module split (warren-041e / pl-9088 step 5):
 *
 *   - `./bridge.ts`           — `bridgeRunStream` pump
 *   - `./terminal-detect.ts`  — `detectRuntimeTerminal`, `isPiAgentEnd`
 *   - `./run-state-poller.ts` — burrow `runs.get` fallback (warren-6596)
 *   - `./stats.ts`            — pi/claude cost persistence
 *   - `./recover.ts`          — `recoverActiveRunStreams` on warren boot
 *   - `./types.ts`            — shared interfaces + constants
 *
 * Resume semantics. Burrow's `runs.stream` always tails from the start
 * of the burrow's event history (the route doesn't accept `?since=`
 * for the run-scoped variant), so warren dedupes on the consumer side:
 * `EventsRepo.maxSeqForRun(runId)` gives the last seq we persisted, and
 * any incoming event whose `seq <= maxSeq` is dropped. This is the
 * "MAX(events.burrow_event_seq) + 1" recovery point in SPEC §4.3 — we
 * implement it client-side because the wire route doesn't.
 *
 * The bridge swallows transport-layer errors (BurrowUnreachableError
 * et al.) and just returns; it logs the failure if a logger was
 * supplied. The supervising layer (Phase 9 HTTP server, Phase 12
 * supervisor) is responsible for restart policy.
 *
 * State mirroring is intentionally limited to the queued → running
 * edge: as soon as the bridge sees its first event from burrow, it
 * atomically claims the warren row via `RunsRepo.claimById` so HTTP
 * clients polling `/runs/:id` stop seeing 'queued' while the agent is
 * actively working. Terminal transitions still belong to Phase 7
 * (reap); the bridge never finalizes a run.
 *
 * Terminal detection (warren-a69a). Burrow's run-stream is an infinite
 * poll on the events table — it never auto-closes when the burrow run
 * reaches a terminal state. Without an in-stream signal, the bridge
 * would keep polling forever and warren's run would stay 'running' even
 * after the agent exited. So the bridge inspects each persisted event
 * for a runtime-terminal shape (claude-code: `kind=state_change`,
 * `stream=system`, `payload.type=result`); on a match, it sets
 * `terminalDetected` on the result and breaks. The registry layer
 * (server/bridges.ts) reads `terminalDetected` and calls `reapRun` —
 * the bridge does not transition warren state itself (mx-fadaa2).
 *
 * Run-state fallback (warren-6596). In-stream terminal detection only
 * fires for runtimes that emit a recognised terminal envelope
 * (claude-code, pi). Declarative agents with `outputFormat=raw-text`
 * (the acceptance stub-shell, many user-authored shell agents) emit
 * only `text` events, so the bridge has no in-stream signal to break on.
 * To cover that gap, the bridge runs a parallel low-frequency poller
 * that calls burrow's `runs.get(burrowRunId)`. When burrow reports a
 * terminal state, the poller waits a short drain window (so the next
 * tail poll picks up final events), then aborts the stream. The bridge
 * synthesises a `terminalDetected` from the burrow state so reap runs
 * exactly as it would have via in-stream detection. Disabled in tests
 * that override `source` without supplying `runStateProbe`.
 *
 * Restart recovery. `recoverActiveRunStreams` walks the runs table for
 * rows in {queued, running} that already have a `burrow_run_id`, and
 * starts a bridge for each. It returns the in-flight bridges so the
 * caller can stop them on shutdown.
 */

export { bridgeRunStream } from "./bridge.ts";
export {
	type ConversationTurnHandler,
	type ConversationTurnHandlerDeps,
	createConversationTurnHandler,
	extractAssistantText,
	extractIntentPatch,
	LEVERET_PLOT_ACTOR,
} from "./conversation-turn.ts";
export {
	type BoundBridgeLogger,
	type BridgeLoggerBindings,
	bindBridgeLogger,
	NOOP_BRIDGE_LOGGER,
} from "./logger.ts";
export {
	type ActiveBridge,
	type RecoverActiveRunStreamsInput,
	type RecoverActiveRunStreamsResult,
	recoverActiveRunStreams,
} from "./recover.ts";
export { detectRuntimeTerminal, isPiAgentEnd } from "./terminal-detect.ts";
export {
	type BridgeLogger,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	DEFAULT_RUN_STATE_DRAIN_MS,
	DEFAULT_RUN_STATE_POLL_MS,
	type PiStatsClient,
	type RunStateProbe,
	type SessionStats,
} from "./types.ts";

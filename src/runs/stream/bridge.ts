/**
 * `bridgeRunStream` — the main event-bridge pump (docs/design/agent-composition.md step 5;
 * event durability per docs/design/runtime-and-supervisor.md). Splits out of the legacy
 * monolithic `src/runs/stream.ts` (warren-041e / pl-9088 step 5):
 * terminal-detection lives in `./terminal-detect.ts`, the run-state
 * fallback in `./run-state-poller.ts`, cost-stats persistence in
 * `./stats.ts`, and active-stream recovery in `./recover.ts`.
 *
 * The bridge is the only writer to `events` (rows always land via
 * `bridgeRunStream` → `EventsRepo.append`); the broker is published
 * to immediately after each row commits so live tailers see fresh
 * events without waiting on a polling interval.
 *
 * See the module-level commentary in `./index.ts` for the full
 * resume / claim / terminal-detection / recovery semantics — keeping
 * docs there so the doctored stream of consciousness stays in one
 * place rather than fanning out across the split.
 */

import type { EventStream, RunTerminalState } from "../../db/schema.ts";
import { EVENT_STREAMS } from "../../db/schema.ts";
import type { RunHandle } from "../../runtime/contract.ts";
import { RuntimeRunNotFoundError } from "../../runtime/errors.ts";
import { resolveCostCapUsd } from "../cost-cap.ts";
import { lifecycleBus } from "../lifecycle-bus.ts";
import {
	accumulatePiUsage,
	extractClaudeUsage,
	newSessionStatsAccumulator,
	type SessionStatsAccumulator,
} from "../usage-aggregate.ts";
import { type CancelBurrowRunFn, enforceBudgetCap } from "./budget.ts";
import { providerStreamSource } from "./provider-source.ts";
import { defaultRunStateProbe, runStatePoller } from "./run-state-poller.ts";
import { persistInStreamUsage, persistPiStatsDelta, snapshotStats } from "./stats.ts";
import { detectRuntimeTerminal, isPiAgentEnd } from "./terminal-detect.ts";
import { recordToolCallRollup, resolveBridgeToolRuntime } from "./tool-call-rollup.ts";
import {
	type BridgeLogger,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	type BurrowTerminalSnapshot,
	DEFAULT_RUN_STATE_DRAIN_MS,
	DEFAULT_RUN_STATE_POLL_MS,
	type RunStateProbe,
	type SessionStats,
	type StreamEventView,
} from "./types.ts";

/**
 * Pump events from burrow's `/runs/:id/stream` into the warren events
 * table and fan-out broker. Returns when the source iterator ends, the
 * signal aborts, or the source throws — whichever comes first.
 *
 * The function is async-iteration shaped (one pass, no resume after
 * return) — call it again from the supervisor if the bridge needs to
 * resume against a still-live burrow run.
 */
export async function bridgeRunStream(input: BridgeRunStreamInput): Promise<BridgeRunStreamResult> {
	const { runId, sandboxRunId, repos, broker } = input;
	const ctrl = new AbortController();
	const onAbort = (): void => ctrl.abort();
	if (input.signal !== undefined) {
		if (input.signal.aborted) ctrl.abort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	const resumeSeq = (await repos.events.maxSeqForRun(runId)) ?? 0;

	// Runtime-provider seam (warren-1f56, warren-1fce). The bridge's backend
	// touchpoints — the event stream, the run-state poller, and the budget-cap
	// cancel — route through the provider the domain resolved at boot; there is no
	// burrow fallback here (the caller always threads the active provider).
	const provider = input.runtimeProvider;
	// Seam handle: `sandboxId` is the sandboxId, `providerRunId` the sandboxRunId.
	const handle: RunHandle = {
		runId,
		sandboxId: input.sandboxId,
		providerRunId: sandboxRunId,
	};

	// Stream source. Default: `provider.streamEvents(handle, { sinceSeq })` adapted
	// to the abort controller so the run-state poller's `ctrl.abort()` tears the
	// stream down (the seam hides the signal, so we bridge it to the async-iterator
	// teardown). Passing the resume cursor lets a reconnect after a disconnect
	// re-attach from where the events table left off (warren-1fce) — the in-loop
	// `seq <= resumeSeq` dedup below stays as a belt-and-braces guard for sources
	// that ignore the cursor (e.g. a test `source` override, which bypasses the
	// provider entirely).
	const source: (signal: AbortSignal) => AsyncIterable<StreamEventView> =
		input.source ??
		providerStreamSource(provider, handle, { sinceSeq: resumeSeq }, input.streamTeardownMs);

	// warren-a63d: resolve the run's effective spend cap once. Explicit
	// input wins (tests); otherwise read the cap frozen onto
	// `runs.rendered_agent_json` (per-trigger override already folded over
	// the per-agent value at dispatch). A null cap disables enforcement.
	const costCapUsd = input.costCapUsd ?? (await resolveBridgeCostCap(repos, runId, input.logger));
	// warren-7746: resolve the run's runtime once so each persisted tool event
	// extracts through the correct runtime's shapes into the `tool_calls` rollup.
	const toolRuntime = await resolveBridgeToolRuntime(repos, runId, input.logger);
	// Budget-cap graceful stop is `provider.cancel(handle, reason)` (warren-1f56).
	// A test `source` override leaves the provider path inert — default to a no-op
	// (mirroring the old `sourceClient === null` behavior) so a source-only test
	// never reaches a live backend; tests asserting the cancel fired inject their own.
	const cancelBurrowRun: CancelBurrowRunFn =
		input.cancelBurrowRun ??
		(input.source === undefined
			? (reason: string) => provider.cancel(handle, reason)
			: async () => {});

	// warren-6596: run-state poller. Covers runtimes that don't emit a
	// recognised in-stream terminal envelope (raw-text declarative agents). The
	// default probe reads `provider.status(handle)`. Kept dormant when a test
	// overrides `source` without an explicit probe (mirrors the old
	// `sourceClient === null` gate) so those tests make no backend calls.
	const runStateProbe: RunStateProbe | null =
		input.runStateProbe ??
		(input.source === undefined ? defaultRunStateProbe(provider, handle) : null);
	const probedTerminal: { value: BurrowTerminalSnapshot | null } = { value: null };
	const pollerTask =
		runStateProbe !== null
			? runStatePoller({
					probe: runStateProbe,
					sandboxRunId,
					ctrl,
					pollIntervalMs: input.runStatePollMs ?? DEFAULT_RUN_STATE_POLL_MS,
					drainMs: input.runStateDrainMs ?? DEFAULT_RUN_STATE_DRAIN_MS,
					observed: probedTerminal,
					runId,
					...(input.logger !== undefined ? { logger: input.logger } : {}),
				})
			: null;

	let written = 0;
	let skipped = 0;
	let dropped = 0;
	let errored = false;
	let claimed = false;
	let terminalDetected: { outcome: RunTerminalState } | undefined;
	let sandboxRunMissing = false;
	// pi cost tracking (warren-a7dc, warren-17a4). Two paths:
	//   1. In-stream extraction (default): accumulate `turn_end` usage as
	//      events flow through the bridge. Persisted on terminal.
	//   2. Out-of-band PiStatsClient (override): fetched at baseline +
	//      terminal, delta persisted. Used when the wire format doesn't
	//      carry usage (declarative stubs, custom dispatchers).
	// Both paths are best-effort; failures leave the columns null.
	let statsBaseline: Promise<SessionStats | null> | undefined;
	let statsPersisted = false;
	const piUsage: SessionStatsAccumulator = newSessionStatsAccumulator();
	// claude-code cost tracking (warren-87f9). Single-shot: claude-code
	// emits one `result` envelope at run end carrying `total_cost_usd` +
	// `usage.{input,output,cache_read_input,cache_creation_input}_tokens`.
	// Shape-sniffed in `extractClaudeUsage`; persisted on terminal only
	// when no pi usage was observed (pi path wins for parity).
	const claudeUsage: SessionStatsAccumulator = newSessionStatsAccumulator();

	try {
		for await (const event of source(ctrl.signal)) {
			if (ctrl.signal.aborted) break;
			if (!claimed) {
				const claimedRun = await repos.runs.claimById(runId);
				if (claimedRun !== null) {
					input.logger?.info?.({ runId, sandboxRunId }, "bridge transitioned run queued → running");
					// warren-28ca: the queued → running edge is the production
					// emit for the `run_started` lifecycle hook. `claimById`
					// returns non-null exactly once (the atomic claim), so this
					// fires once per run start and never on a re-observed edge.
					lifecycleBus()?.emitRunStarted({ runId });
				}
				claimed = true;
				if (input.piStats !== undefined) {
					statsBaseline = snapshotStats(
						input.piStats,
						sandboxRunId,
						ctrl.signal,
						"baseline",
						runId,
						input.logger,
					);
				}
			}
			if (event.seq <= resumeSeq) {
				skipped += 1;
				// warren-2206: terminal detection must run even for an already-persisted
				// (deduped) event. A prior bridge pass can append a terminal event and
				// then be torn down (reconnect / abort / process restart) BEFORE its
				// inline reap fires; on the resumed pass that event replays with
				// `seq <= resumeSeq`. If we `continue` before detecting, the terminal is
				// never observed and the run hangs `running` forever. Detect on the
				// persisted event and break so reap still finalizes — without
				// re-appending the row or re-accumulating stats (dedup semantics intact;
				// the prior pass already persisted both).
				const resumedOutcome = detectRuntimeTerminal(event);
				if (resumedOutcome !== null) {
					terminalDetected = { outcome: resumedOutcome };
					input.logger?.info?.(
						{ runId, sandboxRunId, outcome: resumedOutcome, seq: event.seq },
						"bridge observed runtime-terminal on an already-persisted event; reap will finalize",
					);
					break;
				}
				continue;
			}
			if (isPerDeltaNoiseEvent(event)) {
				dropped += 1;
				continue;
			}
			const row = await repos.events.append({
				runId,
				sandboxEventSeq: event.seq,
				ts: toIsoString(event.ts),
				kind: event.kind,
				stream: normalizeStream(event.stream),
				// warren-5a07: persist the parse-boundary provenance the
				// in-memory view already carries instead of dropping it.
				origin: event.origin ?? null,
				payload: event.payload,
			});
			written += 1;
			// warren-7746: fold tool events into the `tool_calls` rollup at
			// append time (best-effort; the boot backfill re-extracts later).
			await recordToolCallRollup(repos, runId, row, toolRuntime, input.logger);
			broker.publish(runId, row);
			// warren-28ca: `event_emitted` is the lifecycle mirror of the
			// broker publish — one persisted run-event row, fanned to
			// boot-wired consumers as a provider-neutral projection. The
			// bridge is the sole writer to `events`, so this is the single
			// production call-site (design doc §5).
			lifecycleBus()?.emitEventEmitted({
				runId,
				seq: row.sandboxEventSeq,
				kind: row.kind,
				stream: row.stream ?? "",
			});

			accumulatePiUsage(piUsage, event);
			extractClaudeUsage(claudeUsage, event);

			// warren-a63d: enforce the spend cap as cumulative cost crosses it.
			// On exceed, the helper persists usage + emits `budget.exceeded` +
			// cancels the burrow run; we break with a `cancelled` outcome so
			// reap finalizes the warren row.
			if (costCapUsd !== null) {
				const exceeded = await enforceBudgetCap({
					runId,
					sandboxRunId,
					costCapUsd,
					piUsage,
					claudeUsage,
					repos,
					broker,
					cancelBurrowRun,
					...(input.logger !== undefined ? { logger: input.logger } : {}),
				});
				if (exceeded) {
					statsPersisted = true;
					terminalDetected = { outcome: "cancelled" };
					break;
				}
			}

			if (!statsPersisted && isPiAgentEnd(event)) {
				statsPersisted = true;
				if (input.piStats !== undefined) {
					await persistPiStatsDelta({
						piStats: input.piStats,
						sandboxRunId,
						runId,
						repos,
						baseline: statsBaseline,
						signal: ctrl.signal,
						logger: input.logger,
					});
				} else {
					await persistInStreamUsage({
						usage: piUsage,
						runtime: "pi",
						runId,
						sandboxRunId,
						repos,
						logger: input.logger,
					});
				}
			}

			const outcome = detectRuntimeTerminal(event);
			if (outcome !== null) {
				terminalDetected = { outcome };
				input.logger?.info?.(
					{ runId, sandboxRunId, outcome, seq: event.seq },
					"bridge observed runtime-terminal event; reap will finalize",
				);
				if (!statsPersisted) {
					statsPersisted = true;
					if (input.piStats !== undefined) {
						await persistPiStatsDelta({
							piStats: input.piStats,
							sandboxRunId,
							runId,
							repos,
							baseline: statsBaseline,
							signal: ctrl.signal,
							logger: input.logger,
						});
					} else if (piUsage.seen) {
						// Prefer pi if observed (mixed-shape stream); claude-code
						// usage is the fallback when no pi `turn_end` ever fired.
						await persistInStreamUsage({
							usage: piUsage,
							runtime: "pi",
							runId,
							sandboxRunId,
							repos,
							logger: input.logger,
						});
					} else {
						await persistInStreamUsage({
							usage: claudeUsage,
							runtime: "claude-code",
							runId,
							sandboxRunId,
							repos,
							logger: input.logger,
						});
					}
				}
				break;
			}
		}
	} catch (err) {
		if (err instanceof RuntimeRunNotFoundError) {
			// warren-b1a9: the backend no longer has this run (machine restart wiped
			// burrow's in-memory store, deliberate cleanup, etc.) — surfaced across
			// the seam as the neutralized `RuntimeRunNotFoundError` (warren-1f56), no
			// longer burrow's raw 404. Surface as a distinct terminal signal so the
			// registry stops reconnecting and reconciles the warren row to `failed`
			// instead of spinning on backoff. Don't set `errored` — errored=true
			// triggers the reconnect loop; the missing-run signal is exactly the case
			// where reconnect is hopeless.
			sandboxRunMissing = true;
			input.logger?.warn?.(
				{ runId, sandboxRunId, written, skipped, err: err.message },
				"run stream bridge: backend reports run not found (ghost run)",
			);
		} else if (probedTerminal.value !== null) {
			// warren-6596: the run-state poller observed burrow terminal and
			// aborted the source. An AbortError surfacing here is intentional —
			// don't flag `errored` (which would trip the registry's reconnect
			// loop). The synthesized `terminalDetected` is set below.
			input.logger?.info?.(
				{
					runId,
					sandboxRunId,
					sandboxState: probedTerminal.value.state,
					err: err instanceof Error ? err.message : String(err),
				},
				"run stream bridge: stream aborted by run-state poller after terminal observation",
			);
		} else {
			errored = true;
			input.logger?.error?.(
				{
					runId,
					sandboxRunId,
					written,
					skipped,
					err: err instanceof Error ? err.message : String(err),
				},
				"run stream bridge errored",
			);
		}
	} finally {
		if (input.signal !== undefined) input.signal.removeEventListener("abort", onAbort);
		ctrl.abort();
		if (pollerTask !== null) await pollerTask;
		broker.close(runId);
	}

	// warren-6596: if the in-stream terminal-detect path didn't fire but the
	// run-state poller saw burrow terminal, synthesise `terminalDetected` so
	// the registry's inline reap still runs. Outcome maps 1:1 from burrow
	// state (succeeded/failed/cancelled). Skipped when terminal was already
	// detected in-stream — the in-stream path is authoritative because it
	// carries exit_code semantics from the runtime parser.
	if (terminalDetected === undefined && !sandboxRunMissing && probedTerminal.value !== null) {
		// warren-9cce: carry the poller's distilled `failure_reason` (only
		// `oom_killed` today) onto the synthesized terminal so the registry's
		// inline reap finalizes with it instead of inferring an anonymous cause.
		const { state, failureReason } = probedTerminal.value;
		terminalDetected = {
			outcome: state,
			...(failureReason !== undefined ? { failureReason } : {}),
		};
		input.logger?.info?.(
			{
				runId,
				sandboxRunId,
				outcome: state,
				...(failureReason !== undefined ? { failureReason } : {}),
			},
			"bridge synthesized terminalDetected from run-state probe",
		);
	}

	input.logger?.info?.(
		{ runId, sandboxRunId, written, skipped, dropped, errored, sandboxRunMissing },
		"run stream bridge ended",
	);
	if (sandboxRunMissing) {
		return { written, skipped, errored, sandboxRunMissing: true };
	}
	return terminalDetected !== undefined
		? { written, skipped, errored, terminalDetected }
		: { written, skipped, errored };
}

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
 * publish-but-dont-persist.
 */
const PER_DELTA_NOISE_TYPES = new Set(["message_update", "tool_execution_update", "message_start"]);

function isPerDeltaNoiseEvent(event: StreamEventView): boolean {
	if (event.kind !== "telemetry" && event.kind !== "state_change") return false;
	const p = event.payload;
	if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
	const t = (p as { type?: unknown }).type;
	return typeof t === "string" && PER_DELTA_NOISE_TYPES.has(t);
}

/**
 * Burrow's wire `stream` is `'stdout' | 'stderr' | 'system'`; warren's
 * column accepts the same enum but is nullable. Coerce unknown values
 * to null so a forward-compatible burrow can ship new stream tags
 * without crashing the bridge — the event still lands, just without a
 * stream tag.
 */
function normalizeStream(value: unknown): EventStream | null {
	if (typeof value !== "string") return null;
	return (EVENT_STREAMS as readonly string[]).includes(value) ? (value as EventStream) : null;
}

function toIsoString(ts: Date | string): string {
	return ts instanceof Date ? ts.toISOString() : ts;
}

/**
 * Resolve the run's spend cap (warren-a63d) from its frozen
 * `runs.rendered_agent_json`. Best-effort: a missing row or read error
 * resolves to `null` (no cap) so a DB hiccup never blocks streaming.
 */
async function resolveBridgeCostCap(
	repos: BridgeRunStreamInput["repos"],
	runId: string,
	logger: BridgeLogger | undefined,
): Promise<number | null> {
	try {
		const run = await repos.runs.require(runId);
		return resolveCostCapUsd(run.renderedAgentJson);
	} catch (err) {
		logger?.warn?.(
			{ runId, err: err instanceof Error ? err.message : String(err) },
			"failed to resolve spend cap; proceeding without enforcement",
		);
		return null;
	}
}

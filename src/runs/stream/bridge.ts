/**
 * `bridgeRunStream` — the main event-bridge pump (SPEC §4.3 step 5,
 * §9 "event durability rationale"). Splits out of the legacy
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
import {
	accumulatePiUsage,
	extractClaudeUsage,
	newSessionStatsAccumulator,
	type SessionStatsAccumulator,
} from "../usage-aggregate.ts";
import { type CancelBurrowRunFn, enforceBudgetCap } from "./budget.ts";
import { extractAssistantText, extractIntentPatch } from "./conversation-turn.ts";
import { providerStreamSource } from "./provider-source.ts";
import { defaultRunStateProbe, runStatePoller } from "./run-state-poller.ts";
import { persistInStreamUsage, persistPiStatsDelta, snapshotStats } from "./stats.ts";
import { detectRuntimeTerminal, isPiAgentEnd } from "./terminal-detect.ts";
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
	const { runId, burrowRunId, repos, broker } = input;
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
	// Seam handle: `sandboxId` is the burrowId, `providerRunId` the burrowRunId.
	const handle: RunHandle = {
		runId,
		sandboxId: input.burrowId,
		providerRunId: burrowRunId,
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
		input.source ?? providerStreamSource(provider, handle, { sinceSeq: resumeSeq });

	// warren-a63d: resolve the run's effective spend cap once. Explicit
	// input wins (tests); otherwise read the cap frozen onto
	// `runs.rendered_agent_json` (per-trigger override already folded over
	// the per-agent value at dispatch). A null cap disables enforcement.
	const costCapUsd = input.costCapUsd ?? (await resolveBridgeCostCap(repos, runId, input.logger));
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
					burrowRunId,
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
	let errored = false;
	let claimed = false;
	let terminalDetected: { outcome: RunTerminalState } | undefined;
	let burrowRunMissing = false;
	// pi cost tracking (warren-a7dc, warren-17a4). Two paths:
	//   1. In-stream extraction (default): accumulate `turn_end` usage as
	//      events flow through the bridge. Persisted on terminal.
	//   2. Out-of-band PiStatsClient (override): fetched at baseline +
	//      terminal, delta persisted. Used when the wire format doesn't
	//      carry usage (declarative stubs, custom dispatchers).
	// Both paths are best-effort; failures leave the columns null.
	let statsBaseline: Promise<SessionStats | null> | undefined;
	let statsPersisted = false;
	// warren-df71: assistant text accumulated within the current conversation
	// turn, flushed to the transcript on `agent_end` (the turn boundary).
	let conversationTurnText = "";
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
					input.logger?.info?.({ runId, burrowRunId }, "bridge transitioned run queued → running");
				}
				claimed = true;
				if (input.piStats !== undefined) {
					statsBaseline = snapshotStats(
						input.piStats,
						burrowRunId,
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
						{ runId, burrowRunId, outcome: resumedOutcome, seq: event.seq },
						"bridge observed runtime-terminal on an already-persisted event; reap will finalize",
					);
					break;
				}
				continue;
			}
			const row = await repos.events.append({
				runId,
				burrowEventSeq: event.seq,
				ts: toIsoString(event.ts),
				kind: event.kind,
				stream: normalizeStream(event.stream),
				payload: event.payload,
			});
			written += 1;
			broker.publish(runId, row);

			accumulatePiUsage(piUsage, event);
			extractClaudeUsage(claudeUsage, event);

			// warren-a63d: enforce the spend cap as cumulative cost crosses it.
			// On exceed, the helper persists usage + emits `budget.exceeded` +
			// cancels the burrow run; we break with a `cancelled` outcome so
			// reap finalizes the warren row.
			if (costCapUsd !== null) {
				const exceeded = await enforceBudgetCap({
					runId,
					burrowRunId,
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

			// warren-df71: conversation keep-alive. A mode:'conversation' run is
			// a long-lived pi-chat session — `agent_end` is a TURN boundary, not
			// a run terminal. Persist the turn's usage + assistant text, apply
			// any propose_intent patch, and KEEP the run `running` (no break, no
			// inline reap). Non-conversation runs skip this whole branch and
			// retain their exact prior lifecycle.
			if (input.mode === "conversation") {
				const assistantText = extractAssistantText(event);
				if (assistantText !== null) conversationTurnText += assistantText;
				const intentPatch = extractIntentPatch(event);
				if (intentPatch !== null) {
					await input.conversationTurn?.applyIntentPatch({ runId, patch: intentPatch });
				}
				if (isPiAgentEnd(event)) {
					await persistInStreamUsage({
						usage: piUsage,
						runtime: "pi",
						runId,
						burrowRunId,
						repos,
						logger: input.logger,
					});
					const turnText = conversationTurnText.trim();
					if (turnText.length > 0) {
						await input.conversationTurn?.persistAssistantTurn({ runId, text: turnText });
					}
					conversationTurnText = "";
					input.logger?.info?.(
						{ runId, burrowRunId, seq: event.seq },
						"conversation run: agent_end treated as turn-end; keeping run alive",
					);
					continue;
				}
			}

			if (!statsPersisted && isPiAgentEnd(event)) {
				statsPersisted = true;
				if (input.piStats !== undefined) {
					await persistPiStatsDelta({
						piStats: input.piStats,
						burrowRunId,
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
						burrowRunId,
						repos,
						logger: input.logger,
					});
				}
			}

			const outcome = detectRuntimeTerminal(event);
			if (outcome !== null) {
				terminalDetected = { outcome };
				input.logger?.info?.(
					{ runId, burrowRunId, outcome, seq: event.seq },
					"bridge observed runtime-terminal event; reap will finalize",
				);
				if (!statsPersisted) {
					statsPersisted = true;
					if (input.piStats !== undefined) {
						await persistPiStatsDelta({
							piStats: input.piStats,
							burrowRunId,
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
							burrowRunId,
							repos,
							logger: input.logger,
						});
					} else {
						await persistInStreamUsage({
							usage: claudeUsage,
							runtime: "claude",
							runId,
							burrowRunId,
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
			burrowRunMissing = true;
			input.logger?.warn?.(
				{ runId, burrowRunId, written, skipped, err: err.message },
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
					burrowRunId,
					burrowState: probedTerminal.value.state,
					err: err instanceof Error ? err.message : String(err),
				},
				"run stream bridge: stream aborted by run-state poller after terminal observation",
			);
		} else {
			errored = true;
			input.logger?.error?.(
				{
					runId,
					burrowRunId,
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
	if (terminalDetected === undefined && !burrowRunMissing && probedTerminal.value !== null) {
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
				burrowRunId,
				outcome: state,
				...(failureReason !== undefined ? { failureReason } : {}),
			},
			"bridge synthesized terminalDetected from run-state probe",
		);
	}

	input.logger?.info?.(
		{ runId, burrowRunId, written, skipped, errored, burrowRunMissing },
		"run stream bridge ended",
	);
	if (burrowRunMissing) {
		return { written, skipped, errored, burrowRunMissing: true };
	}
	return terminalDetected !== undefined
		? { written, skipped, errored, terminalDetected }
		: { written, skipped, errored };
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

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

import { NotFoundError as BurrowNotFoundError, type RunEvent } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { EventStream, RunTerminalState } from "../../db/schema.ts";
import { EVENT_STREAMS } from "../../db/schema.ts";
import { resolveCostCapUsd } from "../cost-cap.ts";
import {
	accumulatePiUsage,
	extractClaudeUsage,
	newSessionStatsAccumulator,
	type SessionStatsAccumulator,
} from "../usage-aggregate.ts";
import { type CancelBurrowRunFn, enforceBudgetCap } from "./budget.ts";
import { extractAssistantText, extractIntentPatch } from "./conversation-turn.ts";
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
	// warren-c0c9: route the stream poll through the worker that owns this
	// burrow. The source override (tests) bypasses the pool entirely.
	const sourceClient =
		input.source !== undefined
			? null
			: (await input.burrowClientPool.clientFor({ burrowId: input.burrowId })).client;
	const source = input.source ?? defaultSource(sourceClient as BurrowClient, burrowRunId);

	// warren-a63d: resolve the run's effective spend cap once. Explicit
	// input wins (tests); otherwise read the cap frozen onto
	// `runs.rendered_agent_json` (per-trigger override already folded over
	// the per-agent value at dispatch). A null cap disables enforcement.
	const costCapUsd = input.costCapUsd ?? (await resolveBridgeCostCap(repos, runId, input.logger));
	const cancelBurrowRun: CancelBurrowRunFn =
		input.cancelBurrowRun ??
		defaultCancelBurrowRun(sourceClient as BurrowClient | null, burrowRunId);

	// warren-6596: run-state poller. Covers runtimes that don't emit a
	// recognised in-stream terminal envelope (raw-text declarative agents).
	// Skipped when neither a probe override nor a real burrow client exists
	// (tests that pass `source` but no `runStateProbe`).
	const runStateProbe: RunStateProbe | null =
		input.runStateProbe ??
		(sourceClient !== null ? defaultRunStateProbe(sourceClient as BurrowClient) : null);
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
						persistInStreamUsage({
							usage: piUsage,
							runtime: "pi",
							runId,
							burrowRunId,
							repos,
							logger: input.logger,
						});
					} else {
						persistInStreamUsage({
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
		if (err instanceof BurrowNotFoundError) {
			// warren-b1a9: burrow no longer has this run (machine restart wiped
			// its in-memory store, deliberate cleanup, etc.). Surface as a
			// distinct terminal signal so the registry stops reconnecting and
			// reconciles the warren row to `failed` instead of spinning on
			// backoff. Don't set `errored` — errored=true triggers the reconnect
			// loop; the missing-run signal is exactly the case where reconnect
			// is hopeless.
			burrowRunMissing = true;
			input.logger?.warn?.(
				{ runId, burrowRunId, written, skipped, err: err.message },
				"run stream bridge: burrow returned 404 for burrow_run_id (ghost run)",
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
		terminalDetected = { outcome: probedTerminal.value.state };
		input.logger?.info?.(
			{ runId, burrowRunId, outcome: probedTerminal.value.state },
			"bridge synthesized terminalDetected from burrow run-state probe",
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
 * Default source factory: shells through the HttpClient. Wrapping in
 * `withTransportMapping` is moot here because the iterator yields
 * after the initial fetch returns — but the initial fetch can still
 * fail with a transport error, and we want that to surface as
 * `BurrowUnreachableError` for consistency with the spawn flow.
 */
function defaultSource(
	client: BurrowClient,
	burrowRunId: string,
): (signal: AbortSignal) => AsyncIterable<RunEvent> {
	return (signal) => {
		return {
			[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
				const inner = client.http.runs.stream(burrowRunId, { signal });
				return {
					next: () =>
						withTransportMapping(client.config, () => inner.next()) as Promise<
							IteratorResult<RunEvent>
						>,
					return: () => inner.return(undefined) as Promise<IteratorResult<RunEvent>>,
				};
			},
		};
	};
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

/**
 * Default graceful-cancel seam for spend-cap enforcement (warren-a63d):
 * forward to the resolved burrow client's `runs.cancel`. When no client
 * is available (tests with a `source` override but no `cancelBurrowRun`),
 * it's a no-op — the bridge still breaks with `cancelled`.
 */
function defaultCancelBurrowRun(
	client: BurrowClient | null,
	burrowRunId: string,
): CancelBurrowRunFn {
	return async (reason: string): Promise<void> => {
		if (client === null) return;
		await withTransportMapping(client.config, () =>
			client.http.runs.cancel(burrowRunId, { reason }),
		);
	};
}

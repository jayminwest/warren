import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";

export function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

/**
 * Infer failure_reason from state-on-entry plus the event log
 * (warren-3c40, warren-5165). Only consulted when `outcome === "failed"`
 * and the caller didn't override.
 *
 *   queued on entry  → never_started (bridge never claimed the row)
 *   running, no model-turn output observed → no_model_response
 *   running, model-turn output observed   → crashed
 *
 * "Model-turn output" = any event with `kind` in {text, thinking,
 * tool_use} on `stream=stdout`. burrow's jsonl-claude parser maps a
 * claude-code `assistant` envelope into one of those shapes per content
 * block (see burrow `src/runtime/parsers/jsonl-claude.ts`); a run that
 * dies before producing any assistant turn has none of them. The catch-
 * all on unparseable stdout lines also lands as `kind=text` — a known
 * minor false-negative in the rare case where claude-code prints non-
 * JSON to stdout before exiting.
 */
export async function inferFailureReason(
	repos: Repos,
	runId: string,
	stateOnEntry: string,
): Promise<RunFailureReason> {
	if (stateOnEntry === "queued") return "never_started";
	const events = await repos.events.listByRun(runId);
	const sawModelTurn = events.some(
		(ev) =>
			ev.stream === "stdout" &&
			(ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_use"),
	);
	return sawModelTurn ? "crashed" : "no_model_response";
}

export async function transitionToTerminal(
	repos: Repos,
	runId: string,
	currentState: string,
	outcome: RunTerminalState,
	now: Date,
	failureReason: RunFailureReason | null,
): Promise<RunTerminalState> {
	if (currentState === "queued" && outcome !== "cancelled") {
		await repos.runs.markRunning(runId, now);
	}
	const finalized = await repos.runs.finalize(runId, outcome, now, failureReason);
	return finalized.state as RunTerminalState;
}

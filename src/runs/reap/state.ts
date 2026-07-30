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
 *   running, no model-turn output, sandbox error on stderr → sandbox_failed
 *   running, no model-turn output observed → no_model_response
 *   running, model-turn output observed   → crashed
 *
 * The `sandbox_failed` arm (warren-daef): when the sandbox primitive
 * itself breaks (bwrap can't create a user namespace, sandbox-exec
 * refuses the profile), burrow spawns bwrap fine but bwrap exits
 * immediately with its own error on stderr (e.g. `bwrap: setting up uid
 * map: Permission denied`) and the agent never runs. That shape has no
 * model-turn output, so without this arm it collapses into
 * `no_model_response` — which reads as a credential/provider fault and
 * sends the operator down the wrong debugging path.
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
/**
 * The sandbox primitive's own error prefix on stderr. bwrap writes its
 * failures as `bwrap: <message>` (e.g. `bwrap: setting up uid map:
 * Permission denied` when the kernel refuses unprivileged user
 * namespaces); sandbox-exec writes `sandbox-exec: <message>`. Matched
 * per-line so a bwrap error anywhere in a stderr payload qualifies.
 * Deliberately anchored — an agent merely PRINTING "bwrap" in prose
 * must not reclassify its own crash.
 */
const SANDBOX_ERROR_LINE = /^(?:bwrap|sandbox-exec): /m;

/** Read the text body out of an event payload (string or `{text}` shape). */
function eventText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
		const text = (payload as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return "";
}

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
	if (sawModelTurn) return "crashed";
	const sawSandboxError = events.some(
		(ev) => ev.stream === "stderr" && SANDBOX_ERROR_LINE.test(eventText(ev.payloadJson)),
	);
	return sawSandboxError ? "sandbox_failed" : "no_model_response";
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

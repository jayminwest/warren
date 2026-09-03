import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import { UID_DROP_PREFLIGHT_ERROR_PREFIX } from "../../runtime/k8s/agent-uid-drop.ts";
import { backfillTerminalUsage } from "../usage-hydrate.ts";

export function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

/**
 * Infer failure_reason from state-on-entry plus the event log
 * (warren-3c40, warren-5165). Only consulted when `outcome === "failed"`
 * and the caller didn't override.
 *
 *   queued on entry  → never_started (bridge never claimed the row)
 *   running, stdin_hold_timeout witness on system → agent_died (warren-7f0b)
 *   running, no model-turn output, spawn-exec error on system → spawn_failed
 *   running, no model-turn output, uid-drop preflight refusal on system
 *     → spawn_failed (warren-950d)
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

/**
 * The K8s agent-entrypoint idle-watchdog witness (warren-7f0b): the kind the
 * in-pod stdin-hold controller emits on `stream=system` just before it closes
 * stdin and hard-kills a stdin-held runtime that produced no output past the
 * idle budget (`src/runtime/k8s/agent-stdin-hold.ts`). Its presence on the
 * persisted event log is the durable record that the harness was killed by
 * warren's own liveness guard — the discriminator `inferFailureReason` and the
 * watchdog terminal-reconcile net both key off (general infra-death salvage
 * stays warren-6c94's scope; this arm is only the watchdog-kill shape).
 */
export const STDIN_HOLD_TIMEOUT_WITNESS_KIND = "stdin_hold_timeout";

/** True for the idle-watchdog kill witness (system stream only). */
function isStdinHoldTimeoutEvent(ev: EventRowLike): boolean {
	return ev.stream === "system" && ev.kind === STDIN_HOLD_TIMEOUT_WITNESS_KIND;
}

/**
 * Has the run's event log recorded the K8s entrypoint's watchdog-kill witness?
 * Cheap indexed probe (`hasKind`) so the watchdog reconcile net can call it on
 * every tick for a live pod without a full `listByRun`. (warren-7f0b)
 */
export async function hasStdinHoldTimeoutWitness(repos: Repos, runId: string): Promise<boolean> {
	return repos.events.hasKind(runId, STDIN_HOLD_TIMEOUT_WITNESS_KIND, "system");
}

/**
 * The spawn-exec failure signature (warren-4e2a). When the runtime's
 * spawn seam cannot exec the agent process at all — the docker CLI
 * missing/unexecutable under DockerProvider, or the sandbox binary
 * itself absent under LocalProvider — the process spawn throws and the
 * drive loop collapses the throw into an `error` event on
 * `stream=system` (`src/runtime/local/drive.ts`). Bun reports a missing
 * binary as `Executable not found in $PATH: "<bin>"` (ENOENT); a
 * node-style spawn failure reads `spawn <bin> ENOENT`. Anchored like
 * the sandbox matcher so an agent printing the phrase in prose cannot
 * reclassify its own crash — the event must ALSO ride the system
 * stream, which only warren/runtime-owned writers use.
 */
const SPAWN_EXEC_ERROR_LINE = /(?:Executable not found in \$PATH: |spawn \S+ ENOENT)/;

/** True for a runtime-owned spawn-exec error event (system stream only). */
function isSpawnExecErrorEvent(ev: EventRowLike): boolean {
	return ev.stream === "system" && SPAWN_EXEC_ERROR_LINE.test(eventMessage(ev.payloadJson));
}

/**
 * True for the K8s entrypoint's uid-drop preflight refusal (warren-950d).
 * The in-pod entrypoint emits it on `stream=system` before ever spawning the
 * agent (`src/runtime/k8s/agent-uid-drop.ts`), so the run has zero model
 * turns and — without this arm — collapsed into `no_model_response`, which
 * reads as a credential/provider fault. It is a spawn-class infrastructure
 * failure: the agent process was never started. Anchored to the system
 * stream, which only warren-owned writers reach past the provenance gate.
 */
function isUidDropPreflightErrorEvent(ev: EventRowLike): boolean {
	return (
		ev.stream === "system" &&
		eventMessage(ev.payloadJson).startsWith(UID_DROP_PREFLIGHT_ERROR_PREFIX)
	);
}

/** Any system-stream witness that the agent process never came into existence. */
function isSpawnClassFailureEvent(ev: EventRowLike): boolean {
	return isSpawnExecErrorEvent(ev) || isUidDropPreflightErrorEvent(ev);
}

/**
 * Read the error body out of a system-stream event payload. The drive
 * loop writes spawn-exec failures as `{ message }`; accept a bare string
 * or a `{ text }` shape too so a writer change degrades gracefully.
 */
function eventMessage(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
		const body = payload as { message?: unknown; text?: unknown };
		if (typeof body.message === "string") return body.message;
		if (typeof body.text === "string") return body.text;
	}
	return "";
}

/** The event shape this module reads (a full `EventRow` satisfies it). */
interface EventRowLike {
	readonly stream: string | null;
	readonly kind: string;
	readonly payloadJson: unknown;
}

function sawModelTurnEvent(events: readonly EventRowLike[]): boolean {
	return events.some(
		(ev) =>
			ev.stream === "stdout" &&
			(ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_use"),
	);
}

/**
 * warren-4e2a: detect the spawn-exec failure shape — no model-turn
 * output AND a runtime-owned spawn-exec error event. Reap consults this
 * BEFORE the pipeline so a run whose agent process never existed skips
 * the seeds-state commit and the bookkeeping-branch push (nothing
 * useful happened; the push pollutes the repo).
 */
export async function detectSpawnExecFailure(repos: Repos, runId: string): Promise<boolean> {
	const events = await repos.events.listByRun(runId);
	return !sawModelTurnEvent(events) && events.some(isSpawnClassFailureEvent);
}

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
	// warren-7f0b: the K8s entrypoint's idle watchdog killed the harness — a
	// distinct death from a self-inflicted crash, and the operator-facing signal
	// that the run hung past its liveness budget. Checked first: the witness
	// implies the agent was spawned and ran (stdin-held runtimes only arm the
	// watchdog after a successful spawn), so spawn/sandbox arms can never apply.
	if (events.some(isStdinHoldTimeoutEvent)) return "agent_died";
	if (sawModelTurnEvent(events)) return "crashed";
	// warren-4e2a: the spawn-exec arm wins over the sandbox arm — a
	// spawn that never exec'd is an infra fault one level below a sandbox
	// refusal, and must not read as either a sandbox or a credential fault.
	// warren-950d: the K8s uid-drop preflight refusal joins it — the
	// entrypoint refused to spawn the agent at all.
	if (events.some(isSpawnClassFailureEvent)) return "spawn_failed";
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
	// warren-7116: `reaped_at` stamps the same instant as `ended_at` — the
	// terminal transition IS the reap completing. First-write-wins so an
	// already-stamped row (defensive) keeps its original observation.
	await repos.runs.markReaped(runId, now);
	// warren-b33e: hydrate cost/tokens from events at write time so the
	// row never enters the null-cost state that forces a read-time
	// re-aggregation on every list call. Best-effort inside.
	await backfillTerminalUsage(finalized, repos.events, repos.runs);
	return finalized.state as RunTerminalState;
}

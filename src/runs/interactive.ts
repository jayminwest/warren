/**
 * Interactive run primitive (pl-0344 step 3 / warren-1117).
 *
 * Interactive runs are the respawn-per-turn lifecycle that powers the
 * brainstorm and planner agents (and any future steerable harness). Each
 * user message dispatches a *fresh* burrow turn — there is no persistent
 * agent process across turns. Durable conversation state lives in the
 * Plot's event log; warren reconstructs the prompt context on every turn
 * from `intent + attachments + last N events`, hands it to the agent
 * alongside the new user message, and captures the agent's reply when the
 * burrow run terminates (see reap-side wiring in `reap.ts` for the
 * matching `agent_message` append; this module owns the spawn-side
 * surface).
 *
 * Shape (one turn):
 *
 *   1. Load the prior interactive run row by `runId`. Assert
 *      `mode === "interactive"` and `plot_id !== null` — the primitive
 *      is meaningless without a Plot to read context from, and these
 *      checks are defense in depth against the HTTP handler in step 4
 *      (warren-b3b9).
 *   2. Read the Plot envelope (intent + attachments) and the trailing N
 *      events via a typed `PlotContextReader` seam. Failure is best-effort:
 *      a missing index / corrupted JSONL emits a `plot_context_load_failed`
 *      system event on the *new* turn run after spawn, but does NOT block
 *      the dispatch — the agent can still operate on the user's message
 *      alone and the operator gets a recoverable failure trail.
 *   3. Compose the dispatch prompt: a structured context block
 *      (`<plot_context>` + intent + recent-events digest + attachments
 *      list) followed by the new user message. `composeDispatchPrompt`
 *      then prepends the agent's `system` body as usual.
 *   4. Call `spawnRun({ mode: "interactive", plot_id, prompt: composed })`.
 *      Every burrow-side knob (project refresh, agent rendering, Plot env
 *      injection, run_dispatched Plot append) is inherited from the
 *      existing spawn flow — interactive does not duplicate any of it.
 *   5. After spawn returns, append a `user_message` event onto the new
 *      turn's run id. The event carries the verbatim user message;
 *      surface code (UI chat component, `GET /runs/:id/events`) renders
 *      it interleaved with the agent's later `agent_message` event.
 *
 * What lives elsewhere:
 *   - The matching `agent_message` append at reap (this module exports
 *     `appendAgentMessage` as the helper; reap calls it when the run's
 *     `mode === "interactive"` and the agent's final assistant turn is
 *     captured).
 *   - The HTTP surface (`POST /runs/:id/messages`, mode-aware `POST /runs`,
 *     event streaming) — pl-0344 step 4 / warren-b3b9.
 *   - Blocking question_posed pause detection on *batch* runs — pl-0344
 *     step 5 / warren-2976. The pause budget config
 *     (`agent.pauseTimeoutMs`) is shared between that path and the
 *     batch-side fallback, not used by this primitive's respawn loop.
 *
 * The constants `INTERACTIVE_USER_MESSAGE_KIND` and
 * `INTERACTIVE_AGENT_MESSAGE_KIND` are the canonical event-kind strings —
 * the supervisor pause detector, the reap-side capture, and the UI all
 * reference them rather than literal strings.
 */

import { join } from "node:path";
import type { Plot, PlotEvent } from "@os-eco/plot-cli";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { EventRow, RunRow } from "../db/schema.ts";
import { UserPlotClient } from "../plot-client/index.ts";
import {
	resolveDispatcherHandle,
	type SpawnRunInput,
	type SpawnRunResult,
	spawnRun,
} from "./spawn/index.ts";

/** Event kind for the user's typed message on an interactive run. */
export const INTERACTIVE_USER_MESSAGE_KIND = "user_message" as const;

/** Event kind for the agent's reply on an interactive run. */
export const INTERACTIVE_AGENT_MESSAGE_KIND = "agent_message" as const;

/** How many trailing Plot events to fold into the per-turn prompt by default. */
export const DEFAULT_PLOT_HISTORY_TAIL = 20;

/**
 * The reconstructed Plot context a single interactive turn reads before
 * dispatching. Shape is deliberately conservative — the agent gets the
 * envelope + a recent-events digest, not the full event log, so the
 * prompt stays bounded as conversations grow.
 */
export interface InteractivePlotContext {
	readonly plot: Plot;
	/** Trailing events in chronological order, oldest-first. */
	readonly recentEvents: readonly PlotEvent[];
}

/**
 * Seam for reading Plot context. Default implementation
 * (`defaultPlotContextReader`) opens a `UserPlotClient` against the
 * project's `.plot/` directory; tests substitute a stub to avoid
 * touching disk.
 */
export interface PlotContextReader {
	read(input: {
		readonly plotDir: string;
		readonly plotId: string;
		readonly historyTail: number;
		readonly handle: string;
	}): Promise<InteractivePlotContext>;
}

export const defaultPlotContextReader: PlotContextReader = {
	async read({ plotDir, plotId, historyTail, handle }) {
		const client = new UserPlotClient({
			dir: plotDir,
			actor: { kind: "user", handle, raw: `user:${handle}` },
		});
		try {
			const plotHandle = client.get(plotId);
			const plot = await plotHandle.read();
			const events = await plotHandle.events();
			const recentEvents = historyTail > 0 ? events.slice(-historyTail) : [];
			return { plot, recentEvents };
		} finally {
			client.close();
		}
	},
};

/**
 * Build the dispatch-prompt body for one interactive turn.
 *
 * The body is structured so an agent reading it can pattern-match on
 * the `<plot_context>` block (intent + attachments + recent events) and
 * the `<user_message>` block (the freshly-typed turn). The agent's
 * `system` body is prepended separately by `composeDispatchPrompt`
 * inside `spawnRun`, so this function returns just the user-facing
 * payload.
 *
 * Pure / deterministic — easy to snapshot in tests.
 */
export function buildInteractivePrompt(
	context: InteractivePlotContext | null,
	userMessage: string,
): string {
	const out: string[] = [];
	if (context !== null) {
		out.push("<plot_context>");
		out.push(`<plot id="${context.plot.id}" status="${context.plot.status}">`);
		out.push(`<name>${context.plot.name}</name>`);
		out.push("<intent>");
		out.push(`  <goal>${context.plot.intent.goal}</goal>`);
		if (context.plot.intent.non_goals.length > 0) {
			out.push("  <non_goals>");
			for (const v of context.plot.intent.non_goals) out.push(`    - ${v}`);
			out.push("  </non_goals>");
		}
		if (context.plot.intent.constraints.length > 0) {
			out.push("  <constraints>");
			for (const v of context.plot.intent.constraints) out.push(`    - ${v}`);
			out.push("  </constraints>");
		}
		if (context.plot.intent.success_criteria.length > 0) {
			out.push("  <success_criteria>");
			for (const v of context.plot.intent.success_criteria) out.push(`    - ${v}`);
			out.push("  </success_criteria>");
		}
		out.push("</intent>");
		if (context.plot.attachments.length > 0) {
			out.push("<attachments>");
			for (const a of context.plot.attachments) {
				out.push(`  - [${a.type}] ${a.ref}${a.role ? ` (role=${a.role})` : ""}`);
			}
			out.push("</attachments>");
		}
		if (context.recentEvents.length > 0) {
			out.push(`<recent_events count="${context.recentEvents.length}">`);
			for (const ev of context.recentEvents) {
				out.push(`  ${ev.at} ${ev.actor} ${ev.type} ${summarizeEventData(ev)}`);
			}
			out.push("</recent_events>");
		}
		out.push("</plot>");
		out.push("</plot_context>");
		out.push("");
	}
	out.push("<user_message>");
	out.push(userMessage);
	out.push("</user_message>");
	return out.join("\n");
}

function summarizeEventData(ev: PlotEvent): string {
	// Keep the digest single-line and bounded. The full event log lives on
	// disk for the agent to consult via the `plot` CLI when it needs depth.
	try {
		const data = (ev as { data?: unknown }).data;
		const json = JSON.stringify(data ?? {});
		return json.length > 200 ? `${json.slice(0, 200)}\u2026` : json;
	} catch {
		return "{}";
	}
}

/**
 * Input bag for `spawnInteractiveTurn`.
 *
 * Every spawn-side dep is forwarded into the underlying `spawnRun` call;
 * `repos`, `burrowClientPool`, and `message` are the only fields unique
 * to this entry point. `runId` is the **prior** interactive run that
 * anchors the conversation — its `plot_id`, `project_id`, and
 * `agent_name` are reused for the new turn.
 *
 * The conversation pointer the HTTP layer hands the operator (`POST
 * /runs/:id/messages`) is *always* the latest turn's run id — see step 4.
 */
export type SpawnInteractiveTurnInput = {
	readonly runId: string;
	readonly message: string;
	readonly plotContextReader?: PlotContextReader;
	readonly historyTail?: number;
} & Pick<
	SpawnRunInput,
	| "repos"
	| "burrowClientPool"
	| "trigger"
	| "providerOverride"
	| "modelOverride"
	| "now"
	| "projectsConfig"
	| "projectSpawn"
	| "ref"
	| "refreshProjectFn"
	| "warrenConfigs"
	| "runBranchPrefixDefault"
	| "seedsCli"
	| "dispatcherHandle"
	| "plotAppender"
>;

export interface SpawnInteractiveTurnResult {
	/** Prior run row used as the conversation handle. */
	readonly priorRun: RunRow;
	/** Newly-spawned turn (mode='interactive'). */
	readonly turn: SpawnRunResult;
	/** Persisted `user_message` event on the new turn's run id. */
	readonly userMessageEvent: EventRow;
	/**
	 * `true` when Plot-context load failed and a
	 * `plot_context_load_failed` system event was emitted; the dispatch
	 * still went through with an empty context block. Surfaces to tests
	 * + the HTTP handler so callers can decide whether to warn.
	 */
	readonly plotContextDegraded: boolean;
}

export async function spawnInteractiveTurn(
	input: SpawnInteractiveTurnInput,
): Promise<SpawnInteractiveTurnResult> {
	if (input.message.trim() === "") {
		throw new ValidationError("interactive message cannot be empty");
	}

	const priorRun = await input.repos.runs.get(input.runId);
	if (priorRun === null) {
		throw new NotFoundError(`run not found: ${input.runId}`);
	}
	if (priorRun.mode !== "interactive") {
		throw new ValidationError(
			`run ${priorRun.id} has mode '${priorRun.mode}'; only interactive runs accept messages`,
		);
	}
	if (priorRun.plotId === null || priorRun.plotId === "") {
		throw new ValidationError(
			`interactive run ${priorRun.id} has no plot_id; interactive runs require a Plot`,
		);
	}
	if (priorRun.projectId === null) {
		// Defensive: `runs.project_id` is nullable (ON DELETE SET NULL)
		// so an interactive run whose project was deleted can no longer
		// spawn a new turn. Surface as a clean error instead of letting
		// `projects.require(null)` blow up downstream.
		throw new ValidationError(
			`interactive run ${priorRun.id} has no project_id (project was deleted)`,
		);
	}
	// Local non-null aliases so the type narrowing carries through the
	// closures below (TS doesn't keep narrowing across `await` boundaries).
	const plotId: string = priorRun.plotId;
	const projectId: string = priorRun.projectId;

	const project = await input.repos.projects.require(projectId);

	// Best-effort context load. A torn `.plot/.index.db` or a vanished
	// events file should not block the user's turn — a `user_message`
	// event always lands, and we surface the degradation as a system
	// event so the UI can warn.
	const handle = resolveDispatcherHandle(input.dispatcherHandle);
	const reader = input.plotContextReader ?? defaultPlotContextReader;
	const historyTail = input.historyTail ?? DEFAULT_PLOT_HISTORY_TAIL;
	let context: InteractivePlotContext | null = null;
	let contextLoadError: string | null = null;
	try {
		context = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			historyTail,
			handle,
		});
	} catch (err) {
		contextLoadError = err instanceof Error ? err.message : String(err);
	}

	const body = buildInteractivePrompt(context, input.message);

	// Forward every reusable spawn dep through verbatim. Mode is
	// pinned to 'interactive'; plot_id, agent, project come off the
	// prior run row.
	const turn = await spawnRun({
		repos: input.repos,
		burrowClientPool: input.burrowClientPool,
		agentName: priorRun.agentName,
		projectId,
		prompt: body,
		mode: "interactive",
		plotId,
		trigger: input.trigger ?? "interactive",
		...(input.providerOverride !== undefined ? { providerOverride: input.providerOverride } : {}),
		...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
		...(input.projectsConfig !== undefined ? { projectsConfig: input.projectsConfig } : {}),
		...(input.projectSpawn !== undefined ? { projectSpawn: input.projectSpawn } : {}),
		...(input.ref !== undefined ? { ref: input.ref } : {}),
		...(input.refreshProjectFn !== undefined ? { refreshProjectFn: input.refreshProjectFn } : {}),
		...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
		...(input.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: input.runBranchPrefixDefault }
			: {}),
		...(input.seedsCli !== undefined ? { seedsCli: input.seedsCli } : {}),
		...(input.dispatcherHandle !== undefined ? { dispatcherHandle: input.dispatcherHandle } : {}),
		...(input.plotAppender !== undefined ? { plotAppender: input.plotAppender } : {}),
	});

	const userMessageEvent = await appendUserMessage({
		repos: input.repos,
		runId: turn.run.id,
		message: input.message,
		handle,
		now: input.now?.() ?? new Date(),
	});

	if (contextLoadError !== null) {
		await recordPlotContextLoadFailure(
			input.repos,
			turn.run.id,
			plotId,
			contextLoadError,
			input.now?.() ?? new Date(),
		);
	}

	return {
		priorRun,
		turn,
		userMessageEvent,
		plotContextDegraded: contextLoadError !== null,
	};
}

export interface AppendUserMessageInput {
	readonly repos: SpawnInteractiveTurnInput["repos"];
	readonly runId: string;
	readonly message: string;
	readonly handle: string;
	readonly now?: Date;
}

export async function appendUserMessage(input: AppendUserMessageInput): Promise<EventRow> {
	const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
	return input.repos.events.append({
		runId: input.runId,
		burrowEventSeq: seq,
		ts: (input.now ?? new Date()).toISOString(),
		kind: INTERACTIVE_USER_MESSAGE_KIND,
		stream: "system",
		payload: { actor: `user:${input.handle}`, content: input.message },
	});
}

export interface AppendAgentMessageInput {
	readonly repos: SpawnInteractiveTurnInput["repos"];
	readonly runId: string;
	readonly agentName: string;
	readonly content: string;
	readonly now?: Date;
}

/**
 * Append an `agent_message` event onto an interactive run. Called from
 * reap when the agent's final assistant turn is captured (run.mode ===
 * 'interactive'); the helper is exported so the supervisor's
 * resume-on-answer path (warren-2976) and tests can reuse it.
 */
export async function appendAgentMessage(input: AppendAgentMessageInput): Promise<EventRow> {
	const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
	return input.repos.events.append({
		runId: input.runId,
		burrowEventSeq: seq,
		ts: (input.now ?? new Date()).toISOString(),
		kind: INTERACTIVE_AGENT_MESSAGE_KIND,
		stream: "system",
		payload: { actor: `agent:${input.agentName}:${input.runId}`, content: input.content },
	});
}

async function recordPlotContextLoadFailure(
	repos: SpawnInteractiveTurnInput["repos"],
	runId: string,
	plotId: string,
	reason: string,
	now: Date,
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind: "plot_context_load_failed",
			stream: "system",
			payload: { plotId, reason },
		});
	} catch {
		// Logging-only path; nothing to recover here. Mirrors the
		// recordPlotAppendFailure shape in src/runs/spawn/plot-append.ts.
	}
}

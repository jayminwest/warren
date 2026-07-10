/**
 * Conversation-turn side effects for the stream bridge (warren-df71).
 *
 * A `mode:'conversation'` run is a long-lived leveret/pi-chat session, not a
 * one-shot batch run: the bridge keeps it `running` across turns (see
 * `bridge.ts`). Two per-turn side effects ride on top of that keep-alive:
 *
 *   1. PERSIST ASSISTANT TURNS — nothing else writes `role:'assistant'` to
 *      the `messages` transcript (only the operator turns land via the
 *      conversations handler), so reload + re-wake replay would otherwise be
 *      blank. On each turn boundary (`agent_end`) the bridge flushes the
 *      accumulated assistant text here.
 *   2. WIRE propose_intent — leveret's `propose_intent` extension is a pure
 *      carrier: it echoes a field-scoped intent patch on the
 *      `tool_execution_end` event's `result.details.intent_patch` and writes
 *      nothing itself. The bridge reads that off the stream and applies it
 *      to the active Plot here, as an `intent_edited` write so the
 *      IntentPane (polling `/plots/:id`) fills in.
 *
 * Both methods are best-effort: a failure is logged and swallowed so the
 * bridge keeps couriering events. The pure `extractAssistantText` /
 * `extractIntentPatch` parsers are exported for unit-test reuse.
 */

import { join } from "node:path";
import type { Repos } from "../../db/repos/index.ts";
import {
	createPlotsProjectionSink,
	defaultPlotIntentEditor,
	type EditPlotIntentPatch,
	type PlotIntentEditor,
} from "../../plots/index.ts";
import type { BridgeLogger, StreamEventView } from "./types.ts";

/**
 * Plot actor warren records when applying a leveret `propose_intent` patch
 * host-side. `intent_edited` is a humans-only Plot event (SPEC §6), so the
 * write goes through the user-actor `PlotIntentEditor` seam; warren applies
 * the overseer's proposal on the operator's behalf under this handle.
 */
export const LEVERET_PLOT_ACTOR = "leveret";

export interface ConversationTurnHandler {
	/** Append the turn's assistant text to the conversation transcript. */
	persistAssistantTurn(input: { runId: string; text: string }): Promise<void>;
	/** Apply a leveret `propose_intent` patch to the run's active Plot. */
	applyIntentPatch(input: { runId: string; patch: EditPlotIntentPatch }): Promise<void>;
}

export interface ConversationTurnHandlerDeps {
	readonly repos: Repos;
	/** Plot intent-edit seam; defaults to the live `defaultPlotIntentEditor`. */
	readonly plotIntentEditor?: PlotIntentEditor;
	readonly logger?: BridgeLogger;
}

/**
 * Production `ConversationTurnHandler`. Resolves the owning conversation /
 * Plot from the run row via `repos`, so the bridge only needs to pass the
 * `runId` it already holds.
 */
export function createConversationTurnHandler(
	deps: ConversationTurnHandlerDeps,
): ConversationTurnHandler {
	const editor = deps.plotIntentEditor ?? defaultPlotIntentEditor;
	return {
		async persistAssistantTurn({ runId, text }) {
			try {
				const conversation = await deps.repos.conversations.getByAnchoringRunId(runId);
				if (conversation === null) return;
				await deps.repos.messages.append({
					conversationId: conversation.id,
					role: "assistant",
					content: text,
					runId,
				});
			} catch (err) {
				deps.logger?.warn?.(
					{ runId, err: err instanceof Error ? err.message : String(err) },
					"conversation-turn: failed to persist assistant turn",
				);
			}
		},
		async applyIntentPatch({ runId, patch }) {
			try {
				const run = await deps.repos.runs.get(runId);
				if (run === null || run.plotId === null || run.plotId === "" || run.projectId === null) {
					return;
				}
				const project = await deps.repos.projects.get(run.projectId);
				if (project === null) return;
				await editor.edit({
					plotDir: join(project.localPath, ".plot"),
					plotId: run.plotId,
					handle: LEVERET_PLOT_ACTOR,
					patch,
					projection: createPlotsProjectionSink({ repo: deps.repos.plots, projectId: project.id }),
				});
			} catch (err) {
				deps.logger?.warn?.(
					{ runId, err: err instanceof Error ? err.message : String(err) },
					"conversation-turn: failed to apply propose_intent patch",
				);
			}
		},
	};
}

/**
 * Pull the assistant text out of a pi assistant `text` block event. Burrow's
 * pi parser maps assistant `message_end` text content to
 * `kind:'text', stream:'stdout', payload:{text}`. Returns the non-empty text,
 * or null for any other event shape.
 */
export function extractAssistantText(event: StreamEventView): string | null {
	if (event.kind !== "text" || event.stream !== "stdout") return null;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return null;
	const text = (payload as Record<string, unknown>).text;
	return typeof text === "string" && text.length > 0 ? text : null;
}

/**
 * Pull a leveret intent patch off a `tool_execution_end` event. Burrow's pi
 * parser maps it to `kind:'state_change', stream:'system'` with the envelope
 * in `payload`; the tool's returned `details` ride on `payload.result.details`
 * (see the golden fixtures), so the patch lives at
 * `payload.result.details.intent_patch`. Returns a normalized patch with only
 * the four known intent fields, or null when none are present / well-formed.
 */
export function extractIntentPatch(event: StreamEventView): EditPlotIntentPatch | null {
	if (event.kind !== "state_change" || event.stream !== "system") return null;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return null;
	const env = payload as Record<string, unknown>;
	if (env.type !== "tool_execution_end") return null;
	const result = env.result;
	if (result === null || typeof result !== "object") return null;
	const details = (result as Record<string, unknown>).details;
	if (details === null || typeof details !== "object") return null;
	const intentPatch = (details as Record<string, unknown>).intent_patch;
	if (intentPatch === null || typeof intentPatch !== "object" || Array.isArray(intentPatch)) {
		return null;
	}
	return normalizeIntentPatch(intentPatch as Record<string, unknown>);
}

function normalizeIntentPatch(raw: Record<string, unknown>): EditPlotIntentPatch | null {
	const patch: {
		goal?: string;
		non_goals?: string[];
		constraints?: string[];
		success_criteria?: string[];
	} = {};
	if (typeof raw.goal === "string") patch.goal = raw.goal;
	const nonGoals = stringArray(raw.non_goals);
	if (nonGoals !== null) patch.non_goals = nonGoals;
	const constraints = stringArray(raw.constraints);
	if (constraints !== null) patch.constraints = constraints;
	const successCriteria = stringArray(raw.success_criteria);
	if (successCriteria !== null) patch.success_criteria = successCriteria;
	return Object.keys(patch).length > 0 ? patch : null;
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out = value.filter((v): v is string => typeof v === "string");
	return out.length === value.length ? out : null;
}

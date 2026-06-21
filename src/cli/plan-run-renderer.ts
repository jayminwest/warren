/**
 * Output renderers for the `warren plan` command family (warren-ae0a,
 * pl-55df step 3).
 *
 * The default `ndjson` renderer prints one JSON object per line so the stream
 * stays machine-parseable for pipelines (parity with `warren run`). The
 * `pretty` renderer ports the jq event filter from the upstream `run-plan.sh`
 * harness to TypeScript: timestamped, human-readable blocks for the agent's
 * `text` / `thinking` / `tool_use` / `tool_result` / terminal `result` turns
 * with long-value truncation, plus one-line `plan_run.*` lifecycle markers for
 * child advancement and merge waits. Selected with `--output pretty`; the
 * default stays `ndjson`.
 */

import type {
	CancelPlanRunResponse,
	PlanRunChildRow,
	PlanRunRow,
	PlanRunState,
	RunEvent,
} from "../client/types.ts";
import type { WriteSink } from "./output.ts";
import { writeJsonLine } from "./output.ts";

/** Output mode for the `plan` command family. Default is `ndjson`. */
export type PlanRunOutput = "ndjson" | "pretty";

/**
 * The surface the `plan` commands render through. Both the NDJSON and pretty
 * renderers implement it; the command picks one based on `--output`.
 */
export interface PlanRunRenderer {
	dispatched(planRun: PlanRunRow, children: readonly PlanRunChildRow[]): void;
	event(event: RunEvent): void;
	terminal(planRunId: string, state: PlanRunState): void;
	cancelled(result: CancelPlanRunResponse): void;
}

/** Resolve a renderer for the requested output mode. */
export function createRenderer(output: PlanRunOutput, sink: WriteSink): PlanRunRenderer {
	return output === "pretty" ? createPrettyRenderer(sink) : createNdjsonRenderer(sink);
}

/** NDJSON renderer: one JSON object per line (pipeline parity). */
export function createNdjsonRenderer(sink: WriteSink): PlanRunRenderer {
	return {
		dispatched(planRun, children) {
			writeJsonLine(sink, { event: "plan_run.dispatched", planRun, children });
		},
		event(event) {
			writeJsonLine(sink, {
				event: "plan_run.event",
				runId: event.runId,
				seq: event.seq,
				ts: event.ts,
				kind: event.kind,
				stream: event.stream,
				payload: event.payload,
			});
		},
		terminal(planRunId, state) {
			writeJsonLine(sink, { event: "plan_run.terminal", planRunId, state });
		},
		cancelled(result) {
			writeJsonLine(sink, {
				event: "plan_run.cancelled",
				planRun: result.planRun,
				cancelledChild: result.cancelledChild,
				alreadyTerminal: result.alreadyTerminal,
			});
		},
	};
}

/** Max characters of any single rendered value before truncation kicks in. */
const TRUNCATE_AT = 240;

/** Pretty renderer: timestamped, human-readable blocks. */
export function createPrettyRenderer(sink: WriteSink): PlanRunRenderer {
	const line = (text: string): void => {
		sink.write(`${text}\n`);
	};
	return {
		dispatched(planRun, children) {
			line(
				`▶ plan-run ${planRun.id} dispatched — plan ${planRun.planId}, ` +
					`${children.length} ${children.length === 1 ? "child" : "children"} ` +
					`(agent ${planRun.agentName})`,
			);
			for (const child of children) {
				line(`  · child #${child.seq} ${child.seedId} [${child.state}]`);
			}
		},
		event(event) {
			line(renderEventLine(event));
		},
		terminal(planRunId, state) {
			line(`${terminalGlyph(state)} plan-run ${planRunId} ${state}`);
		},
		cancelled(result) {
			if (result.alreadyTerminal) {
				line(`■ plan-run ${result.planRun.id} already ${result.planRun.state} — nothing to cancel`);
				return;
			}
			const child = result.cancelledChild;
			const suffix = child === null ? "no in-flight child" : `cancelled child #${child.childSeq}`;
			line(`■ plan-run ${result.planRun.id} cancelled — ${suffix}`);
		},
	};
}

/** Map a terminal plan-run state to a leading glyph. */
function terminalGlyph(state: PlanRunState): string {
	if (state === "succeeded") return "✔";
	if (state === "cancelled") return "■";
	return "✗";
}

/** Render one stream event as a single pretty line. */
function renderEventLine(event: RunEvent): string {
	const ts = formatTimestamp(event.ts);
	if (event.kind.startsWith("plan_run.")) {
		return `[${ts}] ${renderLifecycle(event)}`;
	}
	const body = renderAgentBlock(event);
	return `[${ts}] ${body}`;
}

/** Render an agent turn (`text` / `thinking` / `tool_use` / … / `result`). */
function renderAgentBlock(event: RunEvent): string {
	const payload = asRecord(event.payload);
	switch (event.kind) {
		case "text":
			return `assistant: ${truncate(stringField(payload, "text"))}`;
		case "thinking":
			return `thinking: ${truncate(stringField(payload, "thinking") || stringField(payload, "text"))}`;
		case "tool_use":
			return renderToolUse(payload);
		case "tool_result":
			return renderToolResult(payload);
		case "result":
			return renderResult(payload);
		default:
			return renderGeneric(event, payload);
	}
}

/** Render a `tool_use` turn: tool name + its command / input summary. */
function renderToolUse(payload: Record<string, unknown> | null): string {
	const name = stringField(payload, "name") || "tool";
	const input = asRecord(payload?.input);
	const command =
		stringField(input, "command") ||
		stringField(payload, "command") ||
		(input !== null ? compactJson(input) : "");
	return command === "" ? `tool_use ${name}` : `tool_use ${name}: ${truncate(command)}`;
}

/** Render a `tool_result` turn, flagging errors. */
function renderToolResult(payload: Record<string, unknown> | null): string {
	const isError = payload?.is_error === true || payload?.isError === true;
	const content = toolResultContent(payload);
	const label = isError ? "tool_result (error)" : "tool_result";
	return content === "" ? label : `${label}: ${truncate(content)}`;
}

/** Pull a displayable string out of a tool_result `content` field. */
function toolResultContent(payload: Record<string, unknown> | null): string {
	if (payload === null) return "";
	const content = payload.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const text = content
			.map((part) => stringField(asRecord(part), "text"))
			.filter((t) => t !== "")
			.join(" ");
		if (text !== "") return text;
	}
	return stringField(payload, "text");
}

/** Render the terminal `result` turn (cost + duration when present). */
function renderResult(payload: Record<string, unknown> | null): string {
	const subtype = stringField(payload, "subtype") || stringField(payload, "type") || "result";
	const parts = [`result: ${subtype}`];
	const cost = numberField(payload, "total_cost_usd");
	if (cost !== null) parts.push(`cost=$${cost.toFixed(4)}`);
	const duration = numberField(payload, "duration_ms");
	if (duration !== null) parts.push(`duration=${Math.round(duration)}ms`);
	return parts.join(" ");
}

/** Render an unrecognised stream event without losing its shape. */
function renderGeneric(event: RunEvent, payload: Record<string, unknown> | null): string {
	const stream = event.stream === null ? "" : `${event.stream} `;
	const summary = payload === null ? "" : `: ${truncate(compactJson(payload))}`;
	return `${stream}${event.kind}${summary}`;
}

/** Render a `plan_run.*` lifecycle event as a one-line marker. */
function renderLifecycle(event: RunEvent): string {
	const payload = asRecord(event.payload);
	const kind = event.kind.slice("plan_run.".length);
	switch (kind) {
		case "dispatched":
			return `→ dispatched child #${numberField(payload, "seq") ?? "?"} ${stringField(payload, "seedId")}`.trimEnd();
		case "advanced":
			return `→ advanced: merged child #${numberField(payload, "mergedChildSeq") ?? "?"}, dispatched child #${numberField(payload, "dispatchedChildSeq") ?? "?"}`;
		case "merged":
			return `✔ merged child #${numberField(payload, "mergedChildSeq") ?? "?"}`;
		case "waiting_for_merge":
			return `⋯ waiting for merge of child #${numberField(payload, "seq") ?? "?"}`;
		case "waiting_for_pr_reopen":
			return `⋯ waiting for PR reopen of child #${numberField(payload, "seq") ?? "?"}`;
		case "failed":
			return `✗ child #${numberField(payload, "failedSeq") ?? "?"} failed: ${stringField(payload, "reason") || "unknown"}`;
		case "succeeded":
			return "✔ plan-run succeeded";
		default:
			return `plan_run.${kind}${payload === null ? "" : `: ${truncate(compactJson(payload))}`}`;
	}
}

/** Format an ISO timestamp as `HH:MM:SS`, or `--:--:--` when unparseable. */
function formatTimestamp(ts: string): string {
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return "--:--:--";
	return date.toISOString().slice(11, 19);
}

/** Truncate a (possibly multi-line) value, collapsing whitespace. */
function truncate(value: string, max = TRUNCATE_AT): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max)}… (+${collapsed.length - max} chars)`;
}

/** Narrow an unknown to a plain record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Read a string field, defaulting to "". */
function stringField(record: Record<string, unknown> | null, key: string): string {
	const value = record?.[key];
	return typeof value === "string" ? value : "";
}

/** Read a finite number field, or null. */
function numberField(record: Record<string, unknown> | null, key: string): number | null {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** JSON-stringify a record compactly for fallback rendering. */
function compactJson(record: Record<string, unknown>): string {
	try {
		return JSON.stringify(record);
	} catch {
		return "[unserializable]";
	}
}

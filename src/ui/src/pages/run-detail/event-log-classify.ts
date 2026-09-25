import type { RunEvent } from "@/api/types.ts";
import { formatCostUsd, formatTokens, readNumber, readString } from "@/pages/run-detail-format.ts";
import { eventKindLabel, piSubKind, summarizeEvent } from "./event-summary.ts";

/**
 * The run log's line classifier (warren-4a47). Every event becomes one
 * `LogLine` of a kind the log knows how to draw: agent prose reads as
 * prose, tool calls and their output read as a log, and warren's own
 * lifecycle facts read as milestones. Turn bookkeeping (turn_start,
 * tool_execution_* echoes of a call already shown) is `noise`, hidden
 * outside the Everything view. Unknown kinds fall back to the
 * `summarizeEvent` one-liner, so nothing the stream carries is lost.
 *
 * Pure and cached per event object, so a batch of new events only
 * classifies the new ones.
 */

export type LineKind =
	| "message"
	| "thinking"
	| "tool"
	| "result"
	| "milestone"
	| "warning"
	| "steer"
	| "noise";

export interface LogLine {
	readonly event: RunEvent;
	readonly kind: LineKind;
	readonly title: string;
	readonly body: string | null;
	/** Tool name for `tool` lines. */
	readonly tool?: string;
	/** Error-toned result or warning. */
	readonly isError?: boolean;
}

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

/** Text out of a string, a content-part array, or a `{text}` object. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (typeof c === "string" ? c : (readString(asObj(c)?.text) ?? "")))
			.filter((t) => t.length > 0)
			.join("\n");
	}
	return readString(asObj(content)?.text) ?? "";
}

/** The one argument worth showing for a tool call: command, path, pattern. */
export function toolArgs(args: unknown): string {
	const o = asObj(args);
	if (o === null) return typeof args === "string" ? args : "";
	const direct =
		readString(o.command) ??
		readString(o.path) ??
		readString(o.file_path) ??
		readString(o.pattern) ??
		readString(o.url) ??
		readString(o.query);
	if (direct !== null) return direct;
	const json = JSON.stringify(o);
	return json === "{}" ? "" : json;
}

const MILESTONE_TITLES: Readonly<Record<string, string>> = {
	"reap.branch_pushed": "Branch pushed",
	"reap.pr_opened": "Pull request opened",
	"reap.completed": "Run finalized",
	"reap.workspace_destroyed": "Workspace removed",
	"reap.workspace_salvaged": "Workspace salvaged",
	"reap.clone_deltas_applied": "Tracker state mirrored",
	"reap.auto_merge_armed": "Auto-merge armed",
	"reap.auto_merge_skipped": "Auto-merge skipped",
	"seeds.seed_id_closed": "Issue closed",
	"steer.delivered": "Steering message delivered",
	inbox_delivered: "Steering message delivered",
	bridge_recovered: "Sandbox reconnected",
	preview_launched: "Preview launched",
	preview_evicted: "Preview evicted",
	preview_torn_down: "Preview torn down",
};

const WARNING_TITLES: Readonly<Record<string, string>> = {
	reap_failed: "Finalize step failed",
	"reap.push_rejected": "Push blocked",
	"reap.empty_push": "Empty push",
	"reap.orphaned": "Run orphaned",
	"reap.auto_merge_not_armed": "Auto-merge not armed",
	"cancel.requested": "Cancel requested",
	bridge_stalled: "Sandbox unreachable",
	stdin_hold_timeout: "Agent input timed out",
	stream_gap: "Log gap",
	"k8s.pod_warning": "Pod warning",
	oom_killed: "Out of memory",
};

/** Lifecycle envelope types the pi and claude adapters carry in state_change. */
const STATE_MILESTONES: Readonly<Record<string, string>> = {
	agent_start: "Agent started",
	agent_end: "Agent finished",
	compaction_start: "Compacting context",
	compaction_end: "Context compacted",
	auto_retry_start: "Retrying model call",
	auto_retry_end: "Model call retried",
};

function line(event: RunEvent, kind: LineKind, title: string, body: string | null): LogLine {
	return { event, kind, title, body: body === "" ? null : body };
}

function usageLine(p: Obj): string | null {
	const usage = asObj(asObj(p.message)?.usage);
	if (usage === null) return null;
	const parts: string[] = [];
	const inT = readNumber(usage.input);
	const outT = readNumber(usage.output);
	if (inT !== null) parts.push(`${formatTokens(inT)} in`);
	if (outT !== null) parts.push(`${formatTokens(outT)} out`);
	const cost = readNumber(asObj(usage.cost)?.total);
	if (cost !== null) parts.push(formatCostUsd(cost));
	return parts.length > 0 ? parts.join(" · ") : null;
}

function classifyStateChange(event: RunEvent, p: Obj): LogLine {
	const sub = piSubKind(event);
	if (sub === "extension_error") {
		return { ...line(event, "warning", "Extension error", summarizeEvent(event)), isError: true };
	}
	const type = readString(p.type) ?? "";
	const milestone = STATE_MILESTONES[type];
	if (milestone !== undefined) return line(event, "milestone", milestone, null);
	if (type === "result") {
		const isError = p.is_error === true;
		const body = [readString(p.subtype), readNumber(p.total_cost_usd)]
			.filter((v) => v !== null)
			.map((v) => (typeof v === "number" ? formatCostUsd(v) : v))
			.join(" · ");
		return {
			...line(event, "milestone", isError ? "Agent errored" : "Agent result", body),
			isError,
		};
	}
	if (type === "turn_end") return line(event, "noise", "Turn ended", usageLine(p));
	const to = readString(p.state) ?? readString(p.to);
	if (to !== null) return line(event, "milestone", `State: ${to}`, null);
	return line(event, "noise", type !== "" ? type.replace(/_/g, " ") : "state change", null);
}

function classifyTool(event: RunEvent, p: Obj): LogLine {
	const name = readString(p.name) ?? readString(p.toolName) ?? readString(p.tool) ?? "tool";
	const args = toolArgs(p.arguments ?? p.input ?? p.args);
	return { ...line(event, "tool", name, args), tool: name };
}

function classifyResult(event: RunEvent, p: Obj): LogLine {
	const isError = p.isError === true || p.is_error === true;
	const body = textOf(p.content ?? p.result ?? p.output);
	return { ...line(event, "result", isError ? "Tool error" : "Output", body), isError };
}

function classifyWarning(event: RunEvent, p: Obj | null): LogLine {
	const title = WARNING_TITLES[event.kind] ?? eventKindLabel(event);
	const message = readString(p?.message);
	const body = event.kind.startsWith("reap") || message === null ? summarizeEvent(event) : message;
	const isError = event.stream === "stderr" || event.kind === "reap_failed";
	return { ...line(event, "warning", title, body), isError };
}

function milestoneBody(event: RunEvent, p: Obj | null): string | null {
	if (event.kind === "reap.branch_pushed" && p !== null) {
		const ahead = readNumber(p.commitsAhead);
		const branch = readString(p.branch) ?? "";
		const commits = ahead === null ? "" : ` · ${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
		return `${branch}${commits}`;
	}
	if (event.kind === "seeds.seed_id_closed") return readString(p?.id);
	if (event.kind === "steer.delivered" || event.kind === "inbox_delivered") return null;
	if (event.kind === "reap.workspace_destroyed") return null;
	return summarizeEvent(event);
}

function isWarningKind(event: RunEvent): boolean {
	if (event.kind in WARNING_TITLES || event.stream === "stderr") return true;
	return /warning|error|failed/.test(event.kind);
}

function isToolEcho(kind: string): boolean {
	return kind.startsWith("toolcall_") || kind.startsWith("tool_execution_");
}

function classifyByKind(event: RunEvent, p: Obj | null): LogLine | null {
	switch (event.kind) {
		case "text":
		case "message_update": {
			const text = readString(p?.text) ?? readString(p?.delta) ?? textOf(p?.content);
			if (text !== "") return line(event, "message", "Agent", text);
			return line(event, "noise", event.kind, summarizeEvent(event));
		}
		case "thinking":
			return line(event, "thinking", "Thinking", readString(p?.text) ?? textOf(p?.thinking));
		case "tool_use":
			return p === null ? null : classifyTool(event, p);
		case "tool_result":
			return p === null ? null : classifyResult(event, p);
		case "state_change":
		case "telemetry":
			return p === null ? null : classifyStateChange(event, p);
		case "steer.sent":
			return line(event, "steer", "Steering message", readString(p?.body) ?? textOf(p));
		default:
			return null;
	}
}

function classifyUncached(event: RunEvent): LogLine {
	const p = asObj(event.payload);
	const byKind = classifyByKind(event, p);
	if (byKind !== null) return byKind;
	const milestone = MILESTONE_TITLES[event.kind] ?? STATE_MILESTONES[event.kind];
	if (milestone !== undefined) return line(event, "milestone", milestone, milestoneBody(event, p));
	if (isWarningKind(event)) return classifyWarning(event, p);
	if (isToolEcho(event.kind))
		return line(event, "noise", eventKindLabel(event), summarizeEvent(event));
	if (event.kind.startsWith("reap") || event.kind.startsWith("seeds.")) {
		return line(event, "milestone", eventKindLabel(event), summarizeEvent(event));
	}
	return line(event, "noise", eventKindLabel(event), summarizeEvent(event));
}

const CACHE = new WeakMap<RunEvent, LogLine>();

export function classifyEvent(event: RunEvent): LogLine {
	const hit = CACHE.get(event);
	if (hit !== undefined) return hit;
	const out = classifyUncached(event);
	CACHE.set(event, out);
	return out;
}

/* Views ------------------------------------------------------------------ */

export type LogView = "activity" | "conversation" | "tools" | "problems" | "all";

const VIEW_KINDS: Readonly<Record<LogView, ReadonlySet<LineKind> | null>> = {
	activity: new Set(["message", "thinking", "tool", "result", "milestone", "warning", "steer"]),
	conversation: new Set(["message", "thinking", "steer", "milestone", "warning"]),
	tools: new Set(["tool", "result", "warning"]),
	problems: new Set(["warning"]),
	all: null,
};

function isProblem(l: LogLine): boolean {
	return l.kind === "warning" || l.isError === true;
}

export function inView(l: LogLine, view: LogView): boolean {
	if (view === "problems") return isProblem(l);
	const kinds = VIEW_KINDS[view];
	return kinds === null || kinds.has(l.kind);
}

const HAYSTACK = new WeakMap<LogLine, string>();

function haystackOf(l: LogLine): string {
	let h = HAYSTACK.get(l);
	if (h === undefined) {
		h = `${l.title}\n${l.body ?? ""}\n${l.event.kind}`.toLowerCase();
		HAYSTACK.set(l, h);
	}
	return h;
}

/** Lines in `view` whose title, body, or kind contains `query` (case-insensitive). */
export function filterLines(lines: readonly LogLine[], view: LogView, query: string): LogLine[] {
	const needle = query.trim().toLowerCase();
	return lines.filter((l) => inView(l, view) && (needle === "" || haystackOf(l).includes(needle)));
}

export interface ViewCounts {
	readonly conversation: number;
	readonly tools: number;
	readonly problems: number;
}

export function countViews(lines: readonly LogLine[]): ViewCounts {
	let conversation = 0;
	let tools = 0;
	let problems = 0;
	for (const l of lines) {
		if (l.kind === "message" || l.kind === "steer") conversation++;
		if (l.kind === "tool") tools++;
		if (isProblem(l)) problems++;
	}
	return { conversation, tools, problems };
}

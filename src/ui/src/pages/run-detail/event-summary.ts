import type { RunEvent } from "@/api/types.ts";
import {
	findFirstText,
	findToolUseName,
	formatCostUsd,
	formatTokens,
	readCostTotal,
	readNumber,
	readString,
	truncateSummary,
} from "@/pages/run-detail-format.ts";

/**
 * One-line event summaries for the Direction C run-detail event tail
 * (warren-8c85 / pl-7e38 step 4). Moved verbatim in spirit from the
 * legacy run-detail-events.tsx so the summary vocabulary stays
 * single-sourced — the workload inspector's structured tail renders
 * the same one-line facts the old page produced, at the export's
 * densities (seq / wall-clock / kind / summary columns).
 */

/**
 * Pi-runtime event kinds whose payload carries meaningful auxiliary
 * detail (warren-70af). Burrow's pi parser (`src/runtime/parsers/pi.ts`)
 * collapses these into `state_change` / `telemetry` on the `system`
 * stream and preserves the pi envelope `type` inside `payload.type`, so
 * we detect them by peeking at the payload. If a future burrow release
 * promotes any of them to first-class `event.kind` values, the same
 * label is used (kind-direct match takes precedence).
 *
 * Unknown kinds fall through to the generic renderer (mx-0db923).
 */
const PI_SUBKIND_LABELS: Readonly<Record<string, string>> = {
	compaction_start: "compaction ▶",
	compaction_end: "compaction ✓",
	auto_retry_start: "auto-retry ▶",
	auto_retry_end: "auto-retry ✓",
	extension_error: "extension error",
	queue_update: "queue update",
};

export function piSubKind(event: RunEvent): string | null {
	if (event.kind in PI_SUBKIND_LABELS) return event.kind;
	if (event.kind !== "state_change" && event.kind !== "telemetry") return null;
	const p = event.payload;
	if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
	const t = (p as { type?: unknown }).type;
	if (typeof t !== "string") return null;
	return t in PI_SUBKIND_LABELS ? t : null;
}

/** The tail's Errors filter arm selects these rows. */
export function isEventError(event: RunEvent): boolean {
	return event.stream === "stderr" || piSubKind(event) === "extension_error";
}

/** Kind label with pi sub-kind promotion applied. */
export function eventKindLabel(event: RunEvent): string {
	const sub = piSubKind(event);
	return sub !== null ? (PI_SUBKIND_LABELS[sub] ?? event.kind) : event.kind;
}

function usageParts(usage: unknown): string[] {
	const parts: string[] = [];
	if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
		const u = usage as Record<string, unknown>;
		const inT = readNumber(u.input);
		const outT = readNumber(u.output);
		if (inT !== null || outT !== null) {
			const a = inT !== null ? formatTokens(inT) : "?";
			const b = outT !== null ? formatTokens(outT) : "?";
			parts.push(`usage ${a}/${b}`);
		}
		const cost = readCostTotal(u.cost);
		if (cost !== null) parts.push(formatCostUsd(cost));
	}
	return parts;
}

function summarizeMessage(message: Record<string, unknown>): string[] {
	const parts: string[] = [];
	const tool = findToolUseName(message.content);
	if (tool !== null) {
		parts.push(`message (toolCall: ${tool})`);
	} else {
		const text = findFirstText(message.content);
		if (text !== null) parts.push(`message: ${truncateSummary(text.trim(), 80)}`);
		else if (typeof message.role === "string") parts.push(`message (${message.role})`);
		else parts.push("message");
	}
	parts.push(...usageParts(message.usage));
	return parts;
}

function resultParts(payload: Record<string, unknown>): string[] {
	const parts: string[] = [];
	if (payload.is_error === true) parts.push("error");
	const subtype = readString(payload.subtype);
	if (subtype !== null) parts.push(subtype);
	const cost = readNumber(payload.total_cost_usd);
	if (cost !== null) parts.push(formatCostUsd(cost));
	return parts;
}

function summarizeStateChange(payload: Record<string, unknown>): string {
	const t = readString(payload.type);
	if (t === null) return truncateSummary(JSON.stringify(payload));
	const parts: string[] = [t];
	const msg = payload.message;
	if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
		parts.push(...summarizeMessage(msg as Record<string, unknown>));
	}
	if (t === "result") parts.push(...resultParts(payload));
	return parts.join(" · ");
}

function summarizeTool(payload: Record<string, unknown>): string {
	const name =
		readString(payload.name) ?? readString(payload.tool) ?? readString(payload.tool_name);
	const exit = readNumber(payload.exit_code) ?? readNumber(payload.exitCode);
	const parts: string[] = [];
	if (name !== null) parts.push(name);
	if (exit !== null) parts.push(`exit ${exit}`);
	if (parts.length === 0) return truncateSummary(JSON.stringify(payload));
	return parts.join(" · ");
}

function reapCompletedSummary(payload: Record<string, unknown>): string {
	const parts: string[] = [];
	const state = readString(payload.state);
	if (state !== null) parts.push(state);
	if (payload.branchPushed === true) {
		const ahead = readNumber(payload.commitsAhead);
		parts.push(ahead === null ? "pushed" : `pushed (+${ahead})`);
	} else if (payload.branchPushed === false) {
		parts.push("no push");
	}
	if (typeof payload.prUrl === "string") parts.push("PR opened");
	const errs = payload.errors;
	if (Array.isArray(errs) && errs.length > 0) parts.push(`${errs.length} error(s)`);
	return parts.join(" · ") || "reap completed";
}

// warren-b68d: the remediation is the point of this event, so the unblock
// URL goes in the one-line summary rather than only in the expanded payload.
function reapPushRejectedSummary(payload: Record<string, unknown>): string {
	const urls = Array.isArray(payload.unblockUrls) ? payload.unblockUrls : [];
	const locations = Array.isArray(payload.locations) ? payload.locations : [];
	const parts = ["push blocked by repository policy"];
	if (locations.length > 0) parts.push(`${locations.length} location(s)`);
	if (typeof urls[0] === "string") parts.push(`unblock: ${urls[0]}`);
	return parts.join(" · ");
}

function reapFailedSummary(payload: Record<string, unknown>): string {
	const step = readString(payload.step) ?? "?";
	const message = readString(payload.message);
	return message !== null ? `${step}: ${truncateSummary(message, 100)}` : `failed in ${step}`;
}

function summarizeReap(kind: string, payload: Record<string, unknown>): string {
	switch (kind) {
		case "reap.completed":
			return reapCompletedSummary(payload);
		case "reap.pr_opened": {
			const url = readString(payload.prUrl);
			const mode = readString(payload.mode);
			return [mode, url].filter((v): v is string => v !== null).join(" · ") || "pr opened";
		}
		case "reap.empty_push":
			return readString(payload.message) ?? "empty push";
		case "reap.push_rejected":
			return reapPushRejectedSummary(payload);
		case "reap.orphaned":
			return readString(payload.message) ?? "orphaned";
		case "reap_failed":
			return reapFailedSummary(payload);
		default:
			return truncateSummary(JSON.stringify(payload));
	}
}

/**
 * Derive a one-line summary from a RunEvent payload for the events pane
 * (warren-3ad4). Defensive against unknown shapes — anything we can't
 * recognise falls through to a truncated JSON dump. The full payload is
 * still available via the expand toggle, so the summary is allowed to
 * elide detail.
 */
function summarizeKnownKind(event: RunEvent, obj: Record<string, unknown>): string | null {
	if (event.kind === "state_change") return summarizeStateChange(obj);
	if (event.kind === "cancel.requested") {
		return readString(obj.reason) ?? "cancel requested";
	}
	if (event.kind === "agent_start") return "agent_start";
	if (event.kind === "agent_end") return readString(obj.reason) ?? "agent_end";
	if (event.kind === "text" || event.kind === "message_update") {
		const t = readString(obj.text) ?? readString(obj.delta);
		if (t !== null) return truncateSummary(t);
	}
	if (event.kind.startsWith("reap")) return summarizeReap(event.kind, obj);
	if (isToolKind(event.kind)) return summarizeTool(obj);
	return null;
}

function isToolKind(kind: string): boolean {
	return (
		kind.startsWith("toolcall_") || kind.startsWith("tool_execution_") || kind.startsWith("tool_")
	);
}

export function summarizeEvent(event: RunEvent): string {
	const p = event.payload;
	if (typeof p === "string") return truncateSummary(p);
	if (p === null) return "";
	if (typeof p !== "object" || Array.isArray(p)) return truncateSummary(JSON.stringify(p));
	const obj = p as Record<string, unknown>;

	const known = summarizeKnownKind(event, obj);
	if (known !== null) return known;

	const fallback =
		readString(obj.text) ??
		readString(obj.message) ??
		readString(obj.reason) ??
		readString(obj.type);
	if (fallback !== null) return truncateSummary(fallback);
	return truncateSummary(JSON.stringify(obj));
}

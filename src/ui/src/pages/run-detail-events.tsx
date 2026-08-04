import { useEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "@/api/types.ts";
import { StatusIndicator } from "@/components/StatusIndicator.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { AnimatePresence, StreamItem } from "@/components/ui/motion.tsx";
import {
	findFirstText,
	findToolUseName,
	formatCostUsd,
	formatTokens,
	formatWallClock,
	readCostTotal,
	readNumber,
	readString,
	truncateSummary,
} from "@/pages/run-detail-format.ts";

export function EventTail({
	events,
	status,
	error,
	terminal,
}: {
	events: RunEvent[];
	status: string;
	error: string | null;
	terminal: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);

	const sorted = useMemo(() => {
		const copy = [...events];
		copy.sort((a, b) => a.seq - b.seq);
		return copy;
	}, [events]);

	useEffect(() => {
		if (autoScroll && ref.current) {
			ref.current.scrollTop = ref.current.scrollHeight;
		}
	}, [autoScroll]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: sorted.length is the trigger, not a read
	useEffect(() => {
		if (!autoScroll || !ref.current) return;
		ref.current.scrollTop = ref.current.scrollHeight;
	}, [sorted.length, autoScroll]);

	// Disable autoscroll on user intent (wheel up, touch drag), not on scroll position:
	// programmatic scrolls also fire `scroll`, and during event bursts the handler
	// runs after additional content has appended, reading a stale (non-bottom) position
	// and falsely turning autoscroll off. `scroll` here only re-enables, never disables.
	const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
		if (e.deltaY < 0) setAutoScroll(false);
	};
	const onTouchMove = (): void => {
		setAutoScroll(false);
	};
	const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
		const el = e.currentTarget;
		if (el.scrollHeight - el.clientHeight - el.scrollTop < 32) {
			setAutoScroll(true);
		}
	};

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle>Events ({sorted.length})</CardTitle>
				<div className="flex items-center gap-2">
					{terminal ? (
						<StatusIndicator kind="run" status="cancelled" label="terminal" />
					) : (
						<StatusIndicator kind="eventStream" status={status} />
					)}
					<label className="flex items-center gap-1 text-xs text-(--color-muted-foreground)">
						<input
							type="checkbox"
							checked={autoScroll}
							onChange={(e) => setAutoScroll(e.target.checked)}
						/>
						auto-scroll
					</label>
				</div>
			</CardHeader>
			<CardContent>
				{error !== null ? <p className="mb-2 text-xs text-(--color-destructive)">{error}</p> : null}
				<div
					ref={ref}
					onScroll={onScroll}
					onWheel={onWheel}
					onTouchMove={onTouchMove}
					className="h-[480px] overflow-auto rounded-md border bg-(--color-muted)/30 p-2 font-mono text-xs"
				>
					{sorted.length === 0 ? (
						<p className="p-4 text-(--color-muted-foreground)">No events yet.</p>
					) : (
						<AnimatePresence initial={false}>
							{sorted.map((e) => (
								<EventLine key={e.id} event={e} />
							))}
						</AnimatePresence>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

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

function piSubKind(event: RunEvent): string | null {
	if (event.kind in PI_SUBKIND_LABELS) return event.kind;
	if (event.kind !== "state_change" && event.kind !== "telemetry") return null;
	const p = event.payload;
	if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
	const t = (p as { type?: unknown }).type;
	if (typeof t !== "string") return null;
	return t in PI_SUBKIND_LABELS ? t : null;
}

function EventLine({ event }: { event: RunEvent }) {
	return (
		<StreamItem>
			<EventLineInner event={event} />
		</StreamItem>
	);
}

function EventLineInner({ event }: { event: RunEvent }) {
	const sub = piSubKind(event);
	const isError = event.stream === "stderr" || sub === "extension_error";
	const colour = isError
		? "text-rose-700 dark:text-rose-300"
		: event.stream === "system"
			? "text-emerald-700 dark:text-emerald-300"
			: "text-(--color-fg)";
	const displayKind = sub !== null ? (PI_SUBKIND_LABELS[sub] ?? event.kind) : event.kind;
	const summary = summarizeEvent(event);
	const expanded =
		typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload, null, 2);
	return (
		<details className={`group ${colour}`}>
			<summary className="flex cursor-pointer items-baseline gap-2 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-(--color-muted-foreground)">
					[{event.seq}] {formatWallClock(event.ts)}
				</span>
				<span className="shrink-0 font-medium">{displayKind}</span>
				{event.stream ? (
					<span className="shrink-0 text-(--color-muted-foreground)">{event.stream}</span>
				) : null}
				<span className="min-w-0 flex-1 truncate text-(--color-muted-foreground) group-open:hidden">
					{summary}
				</span>
			</summary>
			<pre className="mt-1 mb-2 ml-4 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded bg-(--color-card) p-2 text-(--color-fg)">
				{expanded}
			</pre>
		</details>
	);
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
	const usage = message.usage;
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

function summarizeStateChange(payload: Record<string, unknown>): string {
	const t = readString(payload.type);
	if (t === null) return truncateSummary(JSON.stringify(payload));
	const parts: string[] = [t];
	const msg = payload.message;
	if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
		parts.push(...summarizeMessage(msg as Record<string, unknown>));
	}
	if (t === "result") {
		if (payload.is_error === true) parts.push("error");
		const subtype = readString(payload.subtype);
		if (subtype !== null) parts.push(subtype);
		const cost = readNumber(payload.total_cost_usd);
		if (cost !== null) parts.push(formatCostUsd(cost));
	}
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

function summarizeReap(kind: string, payload: Record<string, unknown>): string {
	if (kind === "reap.completed") {
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
	if (kind === "reap.pr_opened") {
		const url = readString(payload.prUrl);
		const mode = readString(payload.mode);
		return [mode, url].filter((v): v is string => v !== null).join(" · ") || "pr opened";
	}
	if (kind === "reap.empty_push") {
		return readString(payload.message) ?? "empty push";
	}
	if (kind === "reap.orphaned") {
		return readString(payload.message) ?? "orphaned";
	}
	if (kind === "reap_failed") {
		const step = readString(payload.step) ?? "?";
		const message = readString(payload.message);
		return message !== null ? `${step}: ${truncateSummary(message, 100)}` : `failed in ${step}`;
	}
	return truncateSummary(JSON.stringify(payload));
}

/**
 * Derive a one-line summary from a RunEvent payload for the events pane
 * (warren-3ad4). Defensive against unknown shapes — anything we can't
 * recognise falls through to a truncated JSON dump. The full payload is
 * still available via the expand toggle, so the summary is allowed to
 * elide detail.
 */
function summarizeEvent(event: RunEvent): string {
	const p = event.payload;
	if (typeof p === "string") return truncateSummary(p);
	if (p === null) return "";
	if (typeof p !== "object" || Array.isArray(p)) return truncateSummary(JSON.stringify(p));
	const obj = p as Record<string, unknown>;

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
	if (
		event.kind.startsWith("toolcall_") ||
		event.kind.startsWith("tool_execution_") ||
		event.kind.startsWith("tool_")
	) {
		return summarizeTool(obj);
	}

	const fallback =
		readString(obj.text) ??
		readString(obj.message) ??
		readString(obj.reason) ??
		readString(obj.type);
	if (fallback !== null) return truncateSummary(fallback);
	return truncateSummary(JSON.stringify(obj));
}

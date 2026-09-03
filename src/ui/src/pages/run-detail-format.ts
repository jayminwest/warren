import type { ReapCompletedPayload, RunEvent, RunRow } from "@/api/types.ts";

/**
 * Pull the latest `reap.completed` payload off the stream so the header
 * can show whether the push actually shipped commits (warren-f3bb). The
 * run row carries `commitsAhead` as a real column since warren-ab2b, but
 * rows reaped before that migration read NULL (unknown), so the event
 * payload stays the fallback source — without this read the empty-push
 * shape (push exit-0 against unchanged HEAD) would be visually identical
 * to a successful real-work run.
 */
export function extractReapSummary(events: RunEvent[]): ReapCompletedPayload | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev?.kind !== "reap.completed") continue;
		if (ev.payload === null || typeof ev.payload !== "object" || Array.isArray(ev.payload)) {
			return null;
		}
		return ev.payload as ReapCompletedPayload;
	}
	return null;
}

/**
 * warren-6376: true when the bridge's most recent degraded-state signal
 * is a `bridge_stalled` (N failed burrow reconnects) not yet cleared by a
 * later `bridge_recovered`. Drives the "infrastructure unreachable" banner.
 */
export function isBridgeStalled(events: RunEvent[]): boolean {
	for (let i = events.length - 1; i >= 0; i--) {
		const k = events[i]?.kind;
		if (k === "bridge_stalled") return true;
		if (k === "bridge_recovered") return false;
	}
	return false;
}

/**
 * Format `costUsd` for the header badge (warren-a7dc). Sub-dollar costs
 * show three significant decimals so a $0.005 cache-only turn doesn't
 * round to "$0.00"; anything ≥ $1 shows two decimals like a normal
 * currency display.
 */
export function formatCostUsd(cost: number | null | undefined): string {
	if (cost == null) return "—";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost === 0) return "$0.00";
	const minor = cost.toFixed(3);
	return `$${minor}`;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function formatTokenBreakdown(r: RunRow): string | null {
	const parts: string[] = [];
	if (r.tokensInput !== null) parts.push(`${formatTokens(r.tokensInput)} in`);
	if (r.tokensOutput !== null) parts.push(`${formatTokens(r.tokensOutput)} out`);
	if (r.tokensCacheRead !== null && r.tokensCacheRead > 0) {
		parts.push(`${formatTokens(r.tokensCacheRead)} cache-r`);
	}
	if (r.tokensCacheWrite !== null && r.tokensCacheWrite > 0) {
		parts.push(`${formatTokens(r.tokensCacheWrite)} cache-w`);
	}
	return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * Extract HH:MM:SS wall-clock from an ISO timestamp for compact display
 * in the events pane (warren-3ad4). Falls back to the raw string when
 * the timestamp doesn't match — events with a non-ISO `ts` are rare but
 * possible (forward-compat with future burrow shapes).
 */
export function formatWallClock(ts: string): string {
	const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
	return m?.[1] ?? ts;
}

export function truncateSummary(s: string, max = 140): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

export function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

export function readNumber(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

export function readCostTotal(v: unknown): number | null {
	if (typeof v === "number") return v;
	if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
	const total = (v as { total?: unknown }).total;
	return typeof total === "number" ? total : null;
}

export function findToolUseName(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
		const obj = part as Record<string, unknown>;
		if (obj.type === "tool_use" && typeof obj.name === "string") return obj.name;
	}
	return null;
}

export function findFirstText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (typeof part === "string") return part;
		if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
		const obj = part as Record<string, unknown>;
		if (typeof obj.text === "string") return obj.text;
	}
	return null;
}

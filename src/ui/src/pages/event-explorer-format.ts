/**
 * Pure display helpers for the Event explorer page (warren-24b9 /
 * pl-7e38 step 16). Kept import-free and side-effect-free so the repo's
 * `bun test` runner can exercise them without a renderer.
 */

/** Truncation budget for the one-line row summary. */
const SUMMARY_MAX_CHARS = 160;

/** Field names, in preference order, that usually carry the story. */
const SUMMARY_KEYS: readonly string[] = [
	"command",
	"message",
	"text",
	"summary",
	"title",
	"step",
	"state",
	"prUrl",
	"url",
];

function truncate(value: string): string {
	if (value.length <= SUMMARY_MAX_CHARS) return value;
	return `${value.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

function summarizeObject(payload: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of SUMMARY_KEYS) {
		const value = payload[key];
		if (typeof value === "string" && value.length > 0) parts.push(value);
	}
	if (parts.length > 0) return parts.join(" · ");
	// Fall back to the first few scalar fields, key=value style.
	for (const [key, value] of Object.entries(payload)) {
		if (parts.length >= 3) break;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			parts.push(`${key}=${String(value)}`);
		}
	}
	if (parts.length > 0) return parts.join(" · ");
	return "{}";
}

/**
 * One-line summary of an event payload for the dense evidence row. The
 * payload is a free-form harness blob (`unknown` on the wire), so this is
 * display-only formatting — nothing here interprets the event.
 */
export function summarizeEventPayload(payload: unknown): string {
	if (typeof payload === "string") return payload.length > 0 ? payload : "(empty)";
	if (payload === null || payload === undefined) return "—";
	if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
	if (Array.isArray(payload)) {
		return payload.length === 0 ? "[]" : truncate(JSON.stringify(payload));
	}
	if (typeof payload === "object") {
		return truncate(summarizeObject(payload as Record<string, unknown>));
	}
	return "—";
}

/** `HH:MM:SS` (local clock) for the row's time column; raw string if unparseable. */
export function formatEventClock(ts: string): string {
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return ts;
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Tailwind text-color class for the kind column, keyed on the event stream. */
export function streamToneClass(stream: string | null): string {
	switch (stream) {
		case "stdout":
			return "text-(--color-info)";
		case "stderr":
			return "text-(--color-danger)";
		case "system":
			return "text-(--color-text-2)";
		default:
			return "text-(--color-text-3)";
	}
}

/** The time-range presets, as the segmented control renders them. */
export interface TimeRangePreset {
	readonly id: string;
	readonly label: string;
	/** Milliseconds back from now; null = no lower bound. */
	readonly windowMs: number | null;
}

export const TIME_RANGES: readonly TimeRangePreset[] = [
	{ id: "15m", label: "15M", windowMs: 15 * 60_000 },
	{ id: "1h", label: "1H", windowMs: 60 * 60_000 },
	{ id: "24h", label: "24H", windowMs: 24 * 60 * 60_000 },
	{ id: "all", label: "ALL", windowMs: null },
];

/** ISO lower bound for a preset, or undefined when the range is unbounded. */
export function sinceForPreset(preset: TimeRangePreset): string | undefined {
	if (preset.windowMs === null) return undefined;
	return new Date(Date.now() - preset.windowMs).toISOString();
}

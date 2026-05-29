/**
 * Formatting helpers for the Run Analytics dashboard (warren-638a /
 * pl-ad0f step 5).
 *
 * Kept in a dedicated module so the page + its sub-components share one
 * set of token / duration / percentage formatters without re-importing
 * RunDetail internals (formatTokens there is module-private). The cost
 * formatter is the one shared piece — re-exported from RunDetail so the
 * sub-cent rounding rule (mx-9d987a) stays in lockstep.
 */
export { formatCostUsd } from "../RunDetail.tsx";

/** 1_234_567 → "1.2M", 12_345 → "12.3k", 999 → "999". */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

/** Round-trip a possibly-null token count through formatTokens, em-dash on null. */
export function formatTokensOrDash(n: number | null): string {
	return n === null ? "—" : formatTokens(n);
}

/** Milliseconds → compact human duration ("4.2s", "3.1m", "1.4h"). */
export function formatDurationMs(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const s = ms / 1_000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = s / 60;
	if (m < 60) return `${m.toFixed(1)}m`;
	return `${(m / 60).toFixed(1)}h`;
}

/** 0..1 ratio → "92%", null → "—". */
export function formatRate(rate: number | null): string {
	if (rate === null) return "—";
	return `${Math.round(rate * 100)}%`;
}

/** Integer count, em-dash when the underlying value is null. */
export function formatCount(n: number | null): string {
	return n === null ? "—" : n.toLocaleString();
}

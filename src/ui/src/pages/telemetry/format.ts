/**
 * Shared telemetry formatters (warren-18f3): one home for the number
 * shapes the telemetry tabs render, so precision rules cannot drift
 * per-tab again. difficultyScore is a raw float (failureShare +
 * retryRate summed server-side) and renders at two decimals — the
 * precision the deleted run-analytics/format.ts carried.
 */

/** Raw difficulty score → fixed two-decimal string ("0.83"). */
export function formatScore(score: number): string {
	return score.toFixed(2);
}

/** Milliseconds → compact human duration ("54s", "11m 24s", "16.8h"). */
export function formatDuration(ms: number | null): string {
	if (ms === null) return "—";
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 90) return s % 60 === 0 ? `${m}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${(m / 60).toFixed(1)}h`;
}

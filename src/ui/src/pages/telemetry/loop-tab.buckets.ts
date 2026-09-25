import type { RunDayBucket } from "../../api/run-analytics-types.ts";

/**
 * Run-outcome chart buckets (warren-e9cd). The server returns a bucket
 * only for days that had runs, so drawing its series straight made the
 * column count, column width, and axis disagree. These helpers pad the
 * series to one bucket per UTC day across the window, and fold to
 * Monday-keyed weeks for the 90-day view (warren-756e). Pure; tested in
 * loop-tab.buckets.test.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Windows at or above this many days chart one column per week. */
export const WEEKLY_THRESHOLD_DAYS = 90;

function emptyBucket(key: string): RunDayBucket {
	return { key, runs: 0, succeeded: 0, failed: 0, cancelled: 0, active: 0, contextTokensTotal: 0 };
}

function utcDayStart(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Every UTC `YYYY-MM-DD` key from `from`'s day through `to`'s day, inclusive. */
export function dayKeys(from: string, to: string): string[] {
	const start = utcDayStart(Date.parse(from));
	const end = utcDayStart(Date.parse(to));
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
	const keys: string[] = [];
	for (let t = start; t <= end; t += DAY_MS) keys.push(new Date(t).toISOString().slice(0, 10));
	return keys;
}

/**
 * One bucket per day in the window, zero-filled where the server sent
 * none. Buckets outside the window (or the no-start-time sentinel) drop.
 */
export function padDailySeries(
	series: readonly RunDayBucket[],
	from: string,
	to: string,
): RunDayBucket[] {
	const byKey = new Map(series.map((b) => [b.key, b]));
	return dayKeys(from, to).map((key) => byKey.get(key) ?? emptyBucket(key));
}

function mondayKey(key: string): string | null {
	const d = new Date(`${key}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return null;
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d.toISOString().slice(0, 10);
}

/** Collapse daily buckets into Monday-keyed weekly buckets, oldest first. */
export function collapseToWeeks(series: readonly RunDayBucket[]): RunDayBucket[] {
	const weeks = new Map<string, RunDayBucket>();
	for (const b of series) {
		const key = mondayKey(b.key);
		if (key === null) continue;
		const acc = weeks.get(key) ?? emptyBucket(key);
		weeks.set(key, {
			...acc,
			runs: acc.runs + b.runs,
			succeeded: acc.succeeded + b.succeeded,
			failed: acc.failed + b.failed,
			cancelled: acc.cancelled + b.cancelled,
			active: acc.active + b.active,
			contextTokensTotal: acc.contextTokensTotal + b.contextTokensTotal,
		});
	}
	return [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The chart's buckets: padded days, folded to weeks for long windows. */
export function outcomeBuckets(
	series: readonly RunDayBucket[],
	days: number,
	from: string,
	to: string,
): RunDayBucket[] {
	const daily = padDailySeries(series, from, to);
	return days >= WEEKLY_THRESHOLD_DAYS ? collapseToWeeks(daily) : daily;
}

/** A column's segment height as a share of the tallest column, 0-100. */
export function segmentPercent(count: number, maxRuns: number): number {
	if (maxRuns <= 0 || count <= 0) return 0;
	return (count / maxRuns) * 100;
}

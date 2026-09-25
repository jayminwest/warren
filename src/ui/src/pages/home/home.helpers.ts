// Relative imports only: the repo-root `bun test` resolves no `@/` alias.
import type { RunDayBucket } from "../../api/run-analytics-types.ts";
import type { PlanRunRow, RunRow } from "../../api/types.ts";

/**
 * Pure logic behind the Home page (warren-44a2): windows, elapsed time,
 * attention rules, and the day-grouped activity feed.
 */

export type HomeWindow = "1" | "7" | "30";

export const HOME_WINDOWS: readonly { value: HomeWindow; label: string }[] = [
	{ value: "1", label: "24h" },
	{ value: "7", label: "7d" },
	{ value: "30", label: "30d" },
];

export const WINDOW_LABELS: Record<HomeWindow, string> = {
	"1": "24 hours",
	"7": "7 days",
	"30": "30 days",
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Window start as an ISO string, floored to the hour so the analytics
 * query key stays stable between renders.
 */
export function windowStartIso(win: HomeWindow, now: number): string {
	const floored = Math.floor(now / HOUR_MS) * HOUR_MS;
	return new Date(floored - Number(win) * DAY_MS).toISOString();
}

export function greeting(hour: number): string {
	if (hour < 5) return "Working late";
	if (hour < 12) return "Good morning";
	if (hour < 18) return "Good afternoon";
	return "Good evening";
}

/** ISO string or epoch ms → epoch ms; null when absent or unparseable. */
export function toMs(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const ms = typeof value === "number" ? value : new Date(value).getTime();
	return Number.isNaN(ms) ? null : ms;
}

/** Wall-clock time since the run started (or queued), up to its end or now. */
export function runElapsedMs(run: RunRow, now: number): number | null {
	const start = toMs(run.startedAt) ?? toMs(run.createdAt);
	if (start === null) return null;
	const end = toMs(run.endedAt) ?? now;
	return end >= start ? end - start : null;
}

/** "42s", "12m", "1h 04m", "2d 3h". */
export function shortDuration(ms: number | null): string {
	if (ms === null) return "—";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ${String(min % 60).padStart(2, "0")}m`;
	return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

/** "Today", "Yesterday", or "Mon, Sep 22". */
export function dayLabel(at: number, now: number): string {
	const day = new Date(at);
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const startOfDay = new Date(day);
	startOfDay.setHours(0, 0, 0, 0);
	const diffDays = Math.round((today.getTime() - startOfDay.getTime()) / DAY_MS);
	if (diffDays <= 0) return "Today";
	if (diffDays === 1) return "Yesterday";
	return day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** "14:02" in the viewer's locale. */
export function clockTime(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function isLiveRun(run: Pick<RunRow, "state">): boolean {
	return run.state === "running" || run.state === "queued";
}

export function isLivePlan(plan: Pick<PlanRunRow, "state">): boolean {
	return plan.state === "running" || plan.state === "queued";
}

/**
 * A running run is "long" once it passes the window's p95 duration.
 * With no p95 yet (a fresh instance), nothing counts as long.
 */
export function isLongRun(run: RunRow, now: number, p95Ms: number | null): boolean {
	if (run.state !== "running" || p95Ms === null) return false;
	return (runElapsedMs(run, now) ?? 0) > p95Ms;
}

export type FeedFilter = "all" | "live" | "attention" | "shipped";

export type FeedItem =
	| { kind: "run"; at: number; run: RunRow }
	| { kind: "plan"; at: number; plan: PlanRunRow };

export interface FeedGroup {
	label: string;
	items: FeedItem[];
}

function runAt(run: RunRow): number {
	return toMs(run.createdAt) ?? toMs(run.startedAt) ?? 0;
}

function keepItem(item: FeedItem, filter: FeedFilter, isLong: (run: RunRow) => boolean): boolean {
	if (filter === "all") return true;
	if (item.kind === "plan") return filter === "live" && isLivePlan(item.plan);
	const run = item.run;
	if (filter === "live") return isLiveRun(run);
	if (filter === "attention") return run.state === "failed" || isLong(run);
	return run.prState === "merged";
}

/**
 * Runs plus the plan runs that fall inside the runs' time span, filtered,
 * newest first, grouped by day.
 */
export function buildFeed(input: {
	runs: readonly RunRow[];
	planRuns: readonly PlanRunRow[];
	filter: FeedFilter;
	now: number;
	isLong: (run: RunRow) => boolean;
}): FeedGroup[] {
	const runItems: FeedItem[] = input.runs.map((run) => ({ kind: "run", at: runAt(run), run }));
	const oldest = runItems.reduce((min, item) => Math.min(min, item.at), Number.POSITIVE_INFINITY);
	const planItems: FeedItem[] = input.planRuns
		.map((plan): FeedItem => ({ kind: "plan", at: toMs(plan.createdAt) ?? 0, plan }))
		.filter((item) => item.at >= oldest || (item.kind === "plan" && isLivePlan(item.plan)));
	const items = [...runItems, ...planItems]
		.filter((item) => keepItem(item, input.filter, input.isLong))
		.sort((a, b) => b.at - a.at);

	const groups: FeedGroup[] = [];
	for (const item of items) {
		const label = dayLabel(item.at, input.now);
		const last = groups[groups.length - 1];
		if (last && last.label === label) last.items.push(item);
		else groups.push({ label, items: [item] });
	}
	return groups;
}

/** "3 agents are working right now" and its idle/loading siblings. */
export function headline(liveCount: number, isLoading: boolean): string {
	if (liveCount > 0) {
		return `${liveCount} ${liveCount === 1 ? "agent is" : "agents are"} working right now`;
	}
	return isLoading ? "Loading your agents' work" : "No agents are running right now";
}

/**
 * The last `days` UTC day buckets ending today, with the days the server
 * skipped filled in as zero, so the chart spans a real calendar.
 */
export function fillDays(
	series: readonly RunDayBucket[],
	days: number,
	now: number,
): RunDayBucket[] {
	const byKey = new Map(series.map((d) => [d.key, d]));
	const out: RunDayBucket[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const key = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
		out.push(
			byKey.get(key) ?? {
				key,
				runs: 0,
				succeeded: 0,
				failed: 0,
				cancelled: 0,
				active: 0,
				contextTokensTotal: 0,
			},
		);
	}
	return out;
}

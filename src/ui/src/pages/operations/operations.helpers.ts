import type { RunRow } from "@/api/types.ts";
// Relative value import of the kernel — `bun test` at the repo root
// resolves no `@/` alias (only Vite does), so a runtime value import
// through the alias would fail to load (mx-2e4a1a rule).
import { RUN_STATES, type RunState } from "../../../../core/wire.ts";

/**
 * Operations-page helpers (pl-7e38 step 13 / warren-d903). Kept pure so
 * the numbers the page renders are testable without a DOM — everything
 * here derives from real API rows, never fabricates a figure, and
 * treats "unknown" as unknown (null in, null out).
 */

/** Monospace elapsed format from the canvas: `mm:ss` under an hour, `hh:mm:ss` above. */
export function formatDurationMs(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
	const total = Math.floor(ms / 1000);
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * The instant the run entered its current phase: `createdAt` (queued) or
 * `startedAt` (running and beyond). Null on pre-column rows — rendered as
 * "unknown", never zero (warren-0af9).
 */
export function phaseInstant(
	run: Pick<RunRow, "state" | "createdAt" | "startedAt">,
): number | null {
	if (run.state === "queued") return run.createdAt;
	const started = run.startedAt === null ? null : Date.parse(run.startedAt);
	return Number.isFinite(started) ? started : null;
}

/**
 * Elapsed in the current phase, for the ACTIVE WORKLOADS table. A queued
 * run shows queue wait; a running run shows runtime. Unknown instants
 * stay unknown (null), so the cell renders "—".
 */
export function phaseElapsedMs(
	run: Pick<RunRow, "state" | "createdAt" | "startedAt">,
	now: number,
): number | null {
	const instant = phaseInstant(run);
	return instant === null ? null : now - instant;
}

/** The oldest active-phase instant among `runs` in the given state. */
export function oldestPhaseInstant(
	runs: readonly Pick<RunRow, "state" | "createdAt" | "startedAt">[],
	state: RunState,
): number | null {
	let oldest: number | null = null;
	for (const run of runs) {
		if (run.state !== state) continue;
		const instant = phaseInstant(run);
		if (instant === null) continue;
		if (oldest === null || instant < oldest) oldest = instant;
	}
	return oldest;
}

/** Non-terminal runs, freshest phase first — the ACTIVE WORKLOADS rows. */
export function activeWorkloads(
	runs: readonly Pick<RunRow, "state" | "createdAt" | "startedAt">[],
	limit: number,
): RunRow[] {
	const active = runs.filter(
		(run): run is RunRow => run.state === "queued" || run.state === "running",
	);
	const instant = (r: RunRow): number => phaseInstant(r) ?? 0;
	active.sort((a, b) => instant(a) - instant(b));
	return active.slice(0, limit);
}

/**
 * Display order for the lifecycle snapshot: the canvas order — queue,
 * runtime, then the three terminal phases — which is `RUN_STATES`.
 */
export const LIFECYCLE_ORDER: readonly RunState[] = RUN_STATES;

/** `https://host/owner/name.git` / `git@host:owner/name.git` → `owner/name`. */
export function shortRepo(gitUrl: string): string {
	const withoutGit = gitUrl.endsWith(".git") ? gitUrl.slice(0, -4) : gitUrl;
	const parts = withoutGit
		.replaceAll(":", "/")
		.split("/")
		.filter((p) => p.length > 0);
	return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : gitUrl;
}

/** First prompt line, clipped, for the ACTIVITY column. */
export function activityLine(prompt: string): string {
	const line = prompt.trim().split("\n", 1)[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Compact age for "oldest waiting" and elapsed figures: "12s", "4m",
 * "3h 20m", "2d 4h". Unknown, negative, or non-finite ages read "just
 * now" — clocks disagree, never lie.
 */
export function formatAgeMs(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 1000) return "just now";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
	const d = Math.floor(h / 24);
	return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

const WINDOW_LABELS: Readonly<Record<string, string>> = {
	"24h": "last 24h",
	"7d": "last 7 days",
	"30d": "last 30 days",
};

/** Human span for an ops window id ("7d" → "last 7 days"). */
export function windowLabel(window: string): string {
	return WINDOW_LABELS[window] ?? window;
}

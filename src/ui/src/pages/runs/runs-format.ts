import type { RunRow } from "@/api/types.ts";
import { formatCostUsd } from "../run-detail-format.ts";

/**
 * Formatting helpers for the Direction C Runs inventory
 * (warren-9e87 / pl-7e38 step 3). Kept beside the table so the 500-line
 * page budget holds; `formatCostUsd` stays single-sourced in
 * run-detail-format.ts (warren-9679).
 */

/** The run's effective start: `startedAt`, else queued `createdAt` (epoch ms). */
export function startedAtOf(row: RunRow): string | null {
	if (row.startedAt !== null) return row.startedAt;
	if (row.createdAt !== null) return new Date(row.createdAt).toISOString();
	return null;
}

/** "14:12" / "2:31:42" / "3d 04:10" — elapsed between start and end (or now).
 *
 * `now` is REQUIRED (warren-b610): a default `Date.now()` evaluates per
 * render, so a list that only re-renders on its 45s refetch froze live
 * durations. Call sites thread a `useNow` tick (or a fresh `Date.now()`
 * on pages that already poll fast, like run detail).
 */
export function formatDuration(row: RunRow, now: number): string {
	const startIso = startedAtOf(row);
	if (startIso === null) return "—";
	const start = new Date(startIso).getTime();
	if (Number.isNaN(start)) return "—";
	const end = row.endedAt !== null ? new Date(row.endedAt).getTime() : now;
	if (Number.isNaN(end) || end < start) return "—";
	return formatElapsedMs(end - start);
}

/** mm:ss under an hour, h:mm:ss under a day, "Nd hh:mm" above. */
export function formatElapsedMs(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 3600) {
		const min = Math.floor(totalSec / 60);
		const sec = totalSec % 60;
		return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	}
	if (totalSec < 86_400) {
		const hr = Math.floor(totalSec / 3600);
		const min = Math.floor((totalSec % 3600) / 60);
		const sec = totalSec % 60;
		return `${hr}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	}
	const days = Math.floor(totalSec / 86_400);
	const hr = Math.floor((totalSec % 86_400) / 3600);
	const min = Math.floor((totalSec % 3600) / 60);
	return `${days}d ${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "https://github.com/os-eco/warren" → "os-eco/warren". */
export function projectLabel(gitUrl: string | null | undefined, fallback: string): string {
	if (!gitUrl) return fallback;
	const stripped = gitUrl.replace(/^https?:\/\/github\.com\//, "");
	return stripped.length > 0 ? stripped : gitUrl;
}

/**
 * The branch a run works on: the explicit dispatch target, else the
 * composed workspace branch set for every run at dispatch, else the raw
 * clone ref. Null when the row predates the columns.
 */
export function branchLabelOf(row: RunRow): string | null {
	return row.targetBranch ?? row.branch ?? row.ref ?? null;
}

/** First 7 chars of a sha-ish string, "" when absent. */
export function shortSha(sha: string | null | undefined): string {
	if (sha === null || sha === undefined || sha.length === 0) return "";
	return sha.slice(0, 7);
}

/**
 * Runtime handle as it renders on the cell's second line (warren-a0f4):
 * truncated to ~10 chars with a trailing ellipsis when longer, verbatim
 * otherwise — the full value rides on the element's `title`.
 */
export function truncateRuntimeHandle(handle: string): string {
	return handle.length > 10 ? `${handle.slice(0, 10)}…` : handle;
}

/**
 * Run cost as "$0.412"; "—" when unmeasured (never a fabricated $0.00).
 * A subscription-authenticated run (warren-f3c3) renders as an estimate:
 * "~$0.412 est." — the API-priced number is not a bill.
 */
export function runCostLabel(row: RunRow): string {
	if (row.costUsd === null) return "—";
	if (row.costBasis === "subscription_estimate") return `~${formatCostUsd(row.costUsd)} est.`;
	return formatCostUsd(row.costUsd);
}

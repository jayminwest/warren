import type { RunRow } from "@/api/types.ts";
import type { InventoryCardTone } from "@/components/ui/inventory-card.tsx";
// Relative, not `@/` — this module is imported by runs-card.helpers.test.ts,
// which runs under the repo-root `bun test`, where the `@/` alias does not
// resolve (see labels.test.ts for the same constraint).
import { humanizeWireValue } from "../../lib/labels.ts";

/**
 * Pure cell/subline logic for the Runs mobile row card (warren-f8a2):
 * the mock-conformance decisions — state tone + short word, the
 * one-contextual-extra subline, and the near-cap cost thresholds — live
 * here so they stay testable without pulling React into the test graph.
 *
 * The card anatomy itself is docs/ui-revamp/screens/mobile/runs.jsx
 * (runs.jsx:104-127): line 1 = 70px state cell + id + elapsed/cost,
 * line 2 = agent · project · one contextual extra. The old third meta
 * row (relativeTime · trigger · commits) is gone.
 */

/** Near-cap threshold for the subline's "cap N%" extra (mock: cap 94%). */
export const CAP_SUBLINE_RATIO = 0.8;
/** Warning-tint threshold for the cost note (mock runs.jsx:147). */
export const CAP_WARNING_RATIO = 0.9;

export interface RunStateCell {
	readonly tone: InventoryCardTone;
	readonly label: string;
}

/** State cell (tone + short word), per the mock's state column. */
export function stateCellOf(row: RunRow): RunStateCell {
	switch (row.state) {
		case "running":
			return { tone: "info", label: "running" };
		case "queued":
			return { tone: "warning", label: "queued" };
		case "succeeded":
			// warren-0993: a succeeded run's PR facts pick the short word —
			// "merged" / "PR open" — otherwise the plain state name. The mock
			// paints PR-open with the primary accent; the card vocabulary's
			// closest reachable tone is info.
			if (row.prMergedAt !== null) return { tone: "success", label: "merged" };
			if (row.prState === "open") return { tone: "info", label: "PR open" };
			return { tone: "success", label: "succeeded" };
		case "failed":
			return { tone: "danger", label: "failed" };
		case "cancelled":
			return { tone: "neutral", label: "cancel" };
	}
}

/** "984" from a PR URL's trailing numeric segment; "" when absent. */
function prNumberOf(prUrl: string | null): string {
	if (prUrl === null) return "";
	const segments = prUrl.split("/").filter((s) => s.length > 0);
	const last = segments[segments.length - 1] ?? "";
	return /^\d+$/.test(last) ? last : "";
}

/** Short prose for a failure reason — subline width, tooltip carries raw. */
function shortFailureReason(reason: string): string {
	if (reason === "push_rejected_policy") return "push blocked";
	return humanizeWireValue(reason).toLowerCase();
}

/**
 * Subline: agent · project · ONE contextual extra, per the mock. The extra
 * is picked by state relevance — PR ref for pr-open, commits for delivered,
 * cap % near budget, stop reason for failed. Cancelled rows carry no stop
 * reason on the wire (`failureReason` is null on cancelled), so they stay
 * at two segments.
 */
export function sublineOf(row: RunRow, projectName: string): string {
	const extras: string[] = [row.agentName, projectName];
	const extra = contextualExtraOf(row);
	if (extra !== null) extras.push(extra);
	return extras.join(" · ");
}

function contextualExtraOf(row: RunRow): string | null {
	if (row.state === "failed" && row.failureReason !== null) {
		return shortFailureReason(row.failureReason);
	}
	if (row.state === "succeeded") {
		const pr = prNumberOf(row.prUrl);
		if (pr !== "") return `PR #${pr}`;
		if (row.commitsAhead !== null && row.commitsAhead > 0) {
			return `${row.commitsAhead} commit${row.commitsAhead === 1 ? "" : "s"}`;
		}
		return null;
	}
	if (row.state === "running" || row.state === "queued") {
		const pct = capPctOf(row);
		if (pct !== null) return `cap ${pct}%`;
	}
	return null;
}

/** Cost-vs-cap percentage, rounded, when a cap is known and spend is near it. */
export function capPctOf(row: RunRow): number | null {
	if (row.maxCostUsd === null || row.maxCostUsd === undefined || row.maxCostUsd <= 0) return null;
	if (row.costUsd === null) return null;
	const ratio = row.costUsd / row.maxCostUsd;
	if (ratio < CAP_SUBLINE_RATIO) return null;
	return Math.round(ratio * 100);
}

/** Warning tint once spend crosses the near-cap threshold. */
export function costNoteToneOf(row: RunRow): "default" | "warning" {
	if (row.maxCostUsd === null || row.maxCostUsd === undefined || row.maxCostUsd <= 0) {
		return "default";
	}
	if (row.costUsd === null) return "default";
	return row.costUsd / row.maxCostUsd >= CAP_WARNING_RATIO ? "warning" : "default";
}

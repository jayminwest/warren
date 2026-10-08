/**
 * Shared fixtures for the design-review workflow tests (warren-a694).
 * Test support, not shipped.
 */

import type { ReportContext } from "./outcome.ts";
import { caseNames, type Finding, VERDICT_SCHEMA } from "./verdict.ts";

export const SHA = "0123456789abcdef0123456789abcdef01234567";

export function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		criterion: "hierarchy",
		severity: "minor",
		origin: "diff",
		page: "runs",
		viewport: "desktop",
		theme: "dark",
		evidence: "runs.desktop.dark.png",
		issue: "Two section labels use different tracking.",
		fix: "Use the shared section-label class on both.",
		...overrides,
	};
}

/** A valid verdict document for `runs`; the verdict field follows the findings. */
export function verdictDoc(findings: Finding[] = [], overrides: Record<string, unknown> = {}) {
	const counted = findings.filter((f) => f.origin === "diff");
	const fail =
		counted.some((f) => f.severity === "blocker") ||
		counted.filter((f) => f.severity === "major").length > 2;
	return {
		schema: VERDICT_SCHEMA,
		rubric: 1,
		headSha: SHA,
		verdict: fail ? "fail" : "pass",
		pagesInScope: ["runs"],
		casesReviewed: caseNames("runs"),
		findings,
		summary: "Runs page reviewed in both viewports and themes.",
		...overrides,
	};
}

export function context(overrides: Partial<ReportContext> = {}): ReportContext {
	return {
		headSha: SHA,
		pages: ["runs"],
		allPages: false,
		uiVisualUrl: "https://example.test/runs/99",
		reviewUrl: "https://example.test/runs/100",
		model: "claude-opus-5-5",
		usage: { costUsd: 1.234, turns: 17 },
		evaluator: "success",
		runId: "99",
		...overrides,
	};
}

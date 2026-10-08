/**
 * What the design-review workflow reports, as data (warren-a694).
 *
 * Every path through the workflow ends in one `Outcome`. This module turns
 * it into the `design-review` check run on the PR head and the sticky
 * comment body. It also reads the evaluator's verdict file through the
 * validator in `verdict.ts`, so an unreadable or invalid file fails closed.
 *
 * Pure: no IO, no network. The entry points (`gate.ts`, `prepare.ts`,
 * `report.ts`) do the reads and writes.
 */

import { stickyMarker } from "../ui-visual/sticky-comment.ts";
import {
	type Counts,
	type Decision,
	type Finding,
	parseVerdict,
	RUBRIC_VERSION,
	runCli,
	type Verdict,
} from "./verdict.ts";

/**
 * The check run's name on the PR head. warren-dbef makes it required for
 * UI PRs, so it must never change.
 */
export const CHECK_NAME = "design-review";
/** `<!-- design-review -->`: the sticky comment's key. */
export const DESIGN_REVIEW_MARKER = stickyMarker("design-review");
/** Rows shown per findings table; the rest are counted, not listed. */
export const MAX_ROWS = 25;

export type SkipReason = "no-ui-changes" | "no-rendered-changes";

export type Outcome =
	| { readonly kind: "waiting" }
	| { readonly kind: "skipped"; readonly reason: SkipReason }
	| { readonly kind: "running" }
	| { readonly kind: "not-run" }
	| { readonly kind: "reviewed"; readonly verdict: Verdict; readonly decision: Decision }
	| { readonly kind: "invalid"; readonly errors: readonly string[] };

export interface Usage {
	readonly costUsd: number | null;
	readonly turns: number | null;
}

/** Facts about the run that every report repeats. */
export interface ReportContext {
	readonly headSha: string;
	readonly pages: readonly string[];
	readonly allPages: boolean;
	/** The ui-visual run whose screenshots were reviewed. */
	readonly uiVisualUrl: string;
	/** This workflow's run, where the evaluator's log lives. */
	readonly reviewUrl: string;
	readonly model: string;
	readonly usage: Usage | null;
	/** How the evaluator step ended (`success`, `failure`, `skipped`, ...). */
	readonly evaluator: string;
	/** The ui-visual run id, for the manual re-run hint. */
	readonly runId: string;
}

export type CheckState =
	| { readonly status: "queued" | "in_progress"; readonly title: string; readonly summary: string }
	| {
			readonly status: "completed";
			readonly conclusion: "success" | "failure";
			readonly title: string;
			readonly summary: string;
	  };

const SKIP_TITLES: Record<SkipReason, string> = {
	"no-ui-changes": "Skipped: no src/ui changes",
	"no-rendered-changes": "Skipped: no rendered src/ui changes",
};

/** Read a verdict file's text through the validator; null text means missing. */
export function interpretVerdict(text: string | null, headSha: string): Outcome {
	if (text === null) return { kind: "invalid", errors: ["the evaluator wrote no verdict file"] };
	const files: Record<string, string> = {
		verdict: text,
		meta: JSON.stringify({ headSha }),
	};
	const cli = runCli(["verdict", "--ci-meta", "meta"], (p) => files[p] ?? "");
	if (cli.code === 2) return { kind: "invalid", errors: cli.report.errors };
	const parsed = parseVerdict(JSON.parse(text));
	if (!parsed.ok) return { kind: "invalid", errors: parsed.errors };
	return { kind: "reviewed", verdict: parsed.value, decision: parsed.decision };
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function countLine(c: Counts): string {
	return `${plural(c.blocker, "blocker")}, ${plural(c.major, "major")}, ${plural(c.minor, "minor")}`;
}

/** The check run for an outcome. Only `success` lets a required check pass. */
export function checkFor(outcome: Outcome, ctx: ReportContext | null): CheckState {
	const summary = ctx === null ? "" : commentFor(outcome, ctx).slice(DESIGN_REVIEW_MARKER.length);
	switch (outcome.kind) {
		case "waiting":
			return {
				status: "queued",
				title: "Waiting for ui-visual",
				summary: "This PR changes src/ui. The review starts when the ui-visual run finishes.",
			};
		case "skipped":
			return {
				status: "completed",
				conclusion: "success",
				title: SKIP_TITLES[outcome.reason],
				summary: "Nothing in this PR changes what the web UI renders, so no review ran.",
			};
		case "running":
			return { status: "in_progress", title: "Reviewing screenshots", summary };
		case "not-run":
			return {
				status: "completed",
				conclusion: "failure",
				title: "Not run: ui-visual failed",
				summary,
			};
		case "reviewed": {
			const pass = outcome.decision.verdict === "pass";
			return {
				status: "completed",
				conclusion: pass ? "success" : "failure",
				title: `${pass ? "PASS" : "FAIL"}: ${countLine(outcome.decision.counts)}`,
				summary,
			};
		}
		case "invalid":
			return {
				status: "completed",
				conclusion: "failure",
				title: "No valid verdict (fails closed)",
				summary,
			};
	}
}

/** Credential shapes the evaluator could have been talked into echoing. */
const SECRET = /\b(?:sk-ant-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w{20,})/g;

/**
 * Model text as one inert table cell: no HTML, no mentions, no links,
 * no images, no code spans, no table breaks, no credential-shaped strings.
 */
export function cell(text: string): string {
	return text
		.replace(SECRET, "[redacted]")
		.replace(/[\r\n]+/g, " ")
		.replace(/([\\`*_[\]()!|#~])/g, "\\$1")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/@/g, "&#64;")
		.trim();
}

function scopeLine(ctx: ReportContext): string {
	if (ctx.allPages) return `all ${ctx.pages.length} pages (a shared UI file changed)`;
	if (ctx.pages.length === 0) return "none";
	return ctx.pages.map((p) => `\`${p}\``).join(", ");
}

function table(findings: readonly Finding[]): string[] {
	const rows = findings
		.slice(0, MAX_ROWS)
		.map(
			(f) =>
				`| ${f.severity} | \`${f.criterion}\` | \`${f.page}\` | ${f.viewport} / ${f.theme} | ${cell(f.issue)} | ${cell(f.fix)} | ${cell(f.evidence)} |`,
		);
	const more = findings.length - rows.length;
	return [
		"| Severity | Criterion | Page | Viewport / theme | Issue | Fix | Evidence |",
		"|---|---|---|---|---|---|---|",
		...rows,
		...(more > 0 ? ["", `${plural(more, "more finding")} not shown; see the review run.`] : []),
	];
}

function linksLine(ctx: ReportContext): string {
	return `[Review run](${ctx.reviewUrl}) · [ui-visual run](${ctx.uiVisualUrl})`;
}

function usageLine(ctx: ReportContext): string {
	const parts = [`model \`${cell(ctx.model)}\``];
	if (ctx.usage?.costUsd != null) parts.push(`cost $${ctx.usage.costUsd.toFixed(2)}`);
	if (ctx.usage?.turns != null) parts.push(plural(ctx.usage.turns, "turn"));
	return `Evaluator: ${parts.join(", ")}. ${linksLine(ctx)}`;
}

function reviewedBody(outcome: Extract<Outcome, { kind: "reviewed" }>): string[] {
	const { verdict, decision } = outcome;
	const pass = decision.verdict === "pass";
	const diff = verdict.findings.filter((f) => f.origin === "diff");
	const old = verdict.findings.filter((f) => f.origin === "pre-existing");
	return [
		`### Design review: ${pass ? "PASS" : "FAIL"}`,
		"",
		`Counted from this diff: ${countLine(decision.counts)}. PASS needs no blockers and at most two majors (rubric v${RUBRIC_VERSION}, \`docs/design/ui-design-review.md\`).`,
		"",
		`> ${cell(verdict.summary)}`,
		"",
		...(diff.length === 0 ? ["No findings from this diff."] : table(diff)),
		...(old.length === 0
			? []
			: [
					"",
					`<details><summary>${plural(old.length, "pre-existing finding")} (not counted)</summary>`,
					"",
					...table(old),
					"",
					"</details>",
				]),
	];
}

function invalidBody(outcome: Extract<Outcome, { kind: "invalid" }>, ctx: ReportContext): string[] {
	const errors = outcome.errors.slice(0, 10).map((e) => `- ${cell(e)}`);
	return [
		"### Design review: no valid verdict",
		"",
		"The check fails closed: the evaluator did not produce a verdict that `scripts/design-review/verdict.ts` accepts.",
		`The evaluator step ended with \`${cell(ctx.evaluator)}\`.`,
		"",
		...errors,
		"",
		"Common causes: the evaluator ran out of turns or budget, the PR's pusher has no write access (the action refuses to run for them), or the verdict broke the schema.",
		`A maintainer can re-run the review: \`gh workflow run ui-design-review.yml -f run_id=${ctx.runId}\`.`,
	];
}

/** The sticky comment body for an outcome. Starts with the marker. */
export function commentFor(outcome: Outcome, ctx: ReportContext): string {
	let body: string[];
	switch (outcome.kind) {
		case "reviewed":
			body = reviewedBody(outcome);
			break;
		case "invalid":
			body = invalidBody(outcome, ctx);
			break;
		case "not-run":
			body = [
				"### Design review: not run",
				"",
				"The ui-visual run for this commit failed, so the evaluator did not run. Fix ui-visual first; its next green run starts the review.",
			];
			break;
		case "skipped":
			body = [`### Design review: ${SKIP_TITLES[outcome.reason].toLowerCase()}`];
			break;
		default:
			body = ["### Design review: in progress"];
	}
	const ran = outcome.kind === "reviewed" || outcome.kind === "invalid";
	return [
		DESIGN_REVIEW_MARKER,
		...body,
		"",
		`Commit \`${ctx.headSha.slice(0, 12)}\` · pages: ${scopeLine(ctx)}`,
		ran ? usageLine(ctx) : linksLine(ctx),
	].join("\n");
}

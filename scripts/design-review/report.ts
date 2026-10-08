#!/usr/bin/env bun
/**
 * Publish the design review: the `design-review` check run on the PR head
 * and the sticky PR comment (warren-a694, plan pl-10db step 15).
 *
 * The `report` job of `.github/workflows/ui-design-review.yml` runs this
 * from the default branch's code, after `prepare` and (for a review) the
 * evaluator. Env: `GH_REPO`, `MODE`, `PR`, `HEAD_SHA`, `RUN_ID`,
 * `UI_VISUAL_URL`, `REVIEW_URL`, `PAGES`, `ALL_PAGES`, `SKIP_REASON`,
 * `MODEL`, `EVALUATOR` (the evaluate job's result), `VERDICT_DIR` (the
 * evaluator's uploaded output), `CHECKS_TOKEN` (writes the check run), and
 * `COMMENT_TOKEN` (writes the comment).
 *
 * The verdict passes through `scripts/design-review/verdict.ts` here, in a
 * fresh checkout, against the head sha from the API. Nothing the evaluator
 * job did to its own workspace can change that decision. A missing or
 * invalid verdict fails closed. The process exits 1 when the check fails,
 * so the workflow run mirrors the check.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type GhApi, ghCliApi } from "../ui-visual/gh-api.ts";
import { updateStickyCommentIfPresent, upsertStickyComment } from "../ui-visual/sticky-comment.ts";
import { setCheck } from "./github.ts";
import {
	checkFor,
	commentFor,
	DESIGN_REVIEW_MARKER,
	interpretVerdict,
	type Outcome,
	type ReportContext,
	type SkipReason,
} from "./outcome.ts";
import { parseUsage } from "./usage.ts";

export const VERDICT_FILE = "verdict.json";
export const USAGE_FILE = "usage.json";
const MAX_FILE_BYTES = 1024 * 1024;

export interface ReportInput {
	readonly repo: string;
	readonly mode: string;
	readonly pr: number;
	readonly headSha: string;
	readonly skipReason: string;
	readonly ctx: Omit<ReportContext, "usage">;
	/** The evaluator's output directory, or null when it uploaded nothing. */
	readonly verdictDir: string | null;
	/** Manual calibration re-run: the PR may be closed or merged. */
	readonly allowClosed?: boolean;
}

export interface ReportDeps {
	readonly checks: GhApi;
	readonly comments: GhApi;
	readonly log: (line: string) => void;
}

function readSmall(path: string): string | null {
	if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return null;
	return readFileSync(path, "utf8");
}

function isSkipReason(value: string): value is SkipReason {
	return value === "no-ui-changes" || value === "no-rendered-changes";
}

/** The outcome for the prepare job's mode, reading the verdict for a review. */
export function resolveOutcome(input: ReportInput): Outcome {
	switch (input.mode) {
		case "skip":
			return {
				kind: "skipped",
				reason: isSkipReason(input.skipReason) ? input.skipReason : "no-ui-changes",
			};
		case "not-run":
			return { kind: "not-run" };
		case "review": {
			const dir = input.verdictDir;
			const text = dir === null ? null : readSmall(join(dir, VERDICT_FILE));
			return interpretVerdict(text, input.headSha);
		}
		default:
			return { kind: "invalid", errors: ["the prepare job did not finish"] };
	}
}

/** True while the PR's head is still the commit this review is about. */
async function stillHead(deps: ReportDeps, input: ReportInput): Promise<boolean> {
	const pull = (await deps.comments.request("GET", `repos/${input.repo}/pulls/${input.pr}`)) as {
		state?: string;
		head?: { sha?: string };
	};
	const open = pull.state === "open" || input.allowClosed === true;
	return open && pull.head?.sha === input.headSha;
}

/** Set the check, then the comment. Returns the check's conclusion. */
export async function runReport(deps: ReportDeps, input: ReportInput): Promise<string> {
	const outcome = resolveOutcome(input);
	const usage =
		input.verdictDir === null ? null : parseUsage(readSmall(join(input.verdictDir, USAGE_FILE)));
	const ctx: ReportContext = { ...input.ctx, usage };
	const check = checkFor(outcome, ctx);
	const conclusion = check.status === "completed" ? check.conclusion : check.status;
	deps.log(`PR #${input.pr} at ${input.headSha}: ${outcome.kind}, check ${conclusion}`);
	await setCheck(deps.checks, input.repo, input.headSha, check, { detailsUrl: ctx.reviewUrl });

	if (!(await stillHead(deps, input))) {
		deps.log("the PR moved on or closed; leaving its comment to the newer run");
		return conclusion;
	}
	const target = { repo: input.repo, pr: input.pr, marker: DESIGN_REVIEW_MARKER };
	const body = commentFor(outcome, ctx);
	// A review always speaks; a skip or a not-run only corrects an earlier comment.
	const result =
		outcome.kind === "reviewed" || outcome.kind === "invalid"
			? await upsertStickyComment(deps.comments, target, body)
			: await updateStickyCommentIfPresent(deps.comments, target, body);
	deps.log(`comment: ${result.action}`);
	return conclusion;
}

function env(name: string): string {
	return process.env[name] ?? "";
}

async function main(): Promise<void> {
	const repo = env("GH_REPO");
	const pr = Number(env("PR"));
	const headSha = env("HEAD_SHA");
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0) {
		throw new Error("GH_REPO (owner/repo) and PR (a number) are required");
	}
	if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("HEAD_SHA must be a full commit sha");
	const verdictDir = env("VERDICT_DIR");
	const pages = env("PAGES")
		.split(",")
		.filter((p) => p !== "");
	const conclusion = await runReport(
		{
			checks: ghCliApi(env("CHECKS_TOKEN") || undefined),
			comments: ghCliApi(env("COMMENT_TOKEN") || undefined),
			log: (line) => console.log(line),
		},
		{
			repo,
			mode: env("MODE"),
			pr,
			headSha,
			skipReason: env("SKIP_REASON"),
			verdictDir: verdictDir !== "" && existsSync(verdictDir) ? verdictDir : null,
			allowClosed: env("ALLOW_CLOSED") === "true",
			ctx: {
				headSha,
				pages,
				allPages: env("ALL_PAGES") === "true",
				uiVisualUrl: env("UI_VISUAL_URL"),
				reviewUrl: env("REVIEW_URL"),
				model: env("MODEL"),
				evaluator: env("EVALUATOR") || "not run",
				runId: env("RUN_ID"),
			},
		},
	);
	console.log(`design-review: ${conclusion}`);
	if (conclusion === "failure") process.exitCode = 1;
}

if (import.meta.main) await main();

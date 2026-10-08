#!/usr/bin/env bun
/**
 * Decide what the design review does for one ui-visual run, and stage the
 * evaluator's inputs (warren-a694, plan pl-10db step 15).
 *
 * The `prepare` job of `.github/workflows/ui-design-review.yml` runs this
 * from the default branch's code. Inputs are env vars: `GH_REPO`, `RUN_ID`
 * (the ui-visual run), `OUT_DIR` (the staging directory), `GH_TOKEN`, and
 * `GITHUB_OUTPUT`. It writes the job outputs `pr`, `head_sha`, `run_url`,
 * `pages`, `all_pages`, `skip_reason`, and `mode`:
 *
 *   none     no open PR whose head is this run's head: report nothing
 *   skip     the PR changes nothing the UI renders: the check passes
 *   not-run  ui-visual failed: the check fails without spending a review
 *   review   stage the inputs and mark the check in progress
 *
 * Trust: run metadata and the PR's file list come from the API. The
 * artifact is data the PR's code wrote. It only proposes the PR number,
 * which counts only when that open PR's head is the run's head sha
 * (`verifiedPr`, shared with the ui-visual comment). The staged files are
 * data for the evaluator, never instructions.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type GhApi, ghCliApi } from "../ui-visual/gh-api.ts";
import { ghDownload, type JobDeps, readRun, verifiedPr } from "../ui-visual/pr-comment.ts";
import { listPrFiles, type PrFile, setCheck } from "./github.ts";
import { checkFor, type SkipReason } from "./outcome.ts";
import { allPagesScope, type Scope, scopeForFiles, touchesUi } from "./scope.ts";
import { caseNames } from "./verdict.ts";

/** Cap on the staged diff, so a huge PR cannot blow the evaluator's budget. */
export const MAX_DIFF_CHARS = 200_000;

export type Mode = "none" | "skip" | "not-run" | "review";

export interface PrepareDeps extends JobDeps {
	readonly outDir: string;
	/** One job output line; called as soon as each value is known. */
	readonly output: (key: string, value: string) => void;
	/** This workflow run's URL, for the check's details link. */
	readonly reviewUrl: string;
	/** Manual dispatch only: review a closed or merged PR's last head too. */
	readonly allowClosed?: boolean;
}

/** The rendered UI patches as one unified diff, capped at `max` characters. */
export function buildDiff(
	files: readonly PrFile[],
	rendered: readonly string[],
	max = MAX_DIFF_CHARS,
): string {
	const keep = new Set(rendered);
	let out = "";
	for (const f of files) {
		if (!keep.has(f.filename)) continue;
		const part =
			f.patch === undefined
				? `# ${f.filename}: ${f.status}, no patch from GitHub (binary or too large)\n`
				: `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`;
		if (out.length + part.length > max) {
			return `${out}# diff truncated at ${max} characters; read the files in the PR for the rest\n`;
		}
		out += part;
	}
	return out;
}

/** Copy `ci-meta.json` and the in-scope screenshots into the skill's ARTIFACT_DIR layout. */
export function stageScreenshots(
	artifact: string,
	outDir: string,
	pages: readonly string[],
): string[] {
	const shots = join(outDir, "artifact", "screenshots");
	mkdirSync(shots, { recursive: true });
	const meta = join(artifact, "ci-meta.json");
	if (existsSync(meta)) copyFileSync(meta, join(outDir, "artifact", "ci-meta.json"));
	const staged: string[] = [];
	for (const name of pages.flatMap(caseNames)) {
		const from = join(artifact, "screenshots", `${name}.png`);
		if (!existsSync(from)) continue;
		copyFileSync(from, join(shots, `${name}.png`));
		staged.push(name);
	}
	return staged;
}

function skipReason(files: readonly string[], scope: Scope): SkipReason | null {
	if (!touchesUi(files)) return "no-ui-changes";
	return scope.pages.length === 0 ? "no-rendered-changes" : null;
}

/** The whole prepare step; returns the mode it chose. */
export async function runPrepare(deps: PrepareDeps): Promise<Mode> {
	const run = await readRun(deps);
	if (run === null) return "none";
	const artifact = await deps.download(`ui-screenshots-${run.headSha}`);
	if (artifact === null) {
		deps.log(`run ${deps.runId} uploaded no ui-screenshots-${run.headSha} artifact`);
		return "none";
	}
	const pr = await verifiedPr(deps, artifact, run.headSha, deps.allowClosed === true);
	if (pr === null) return "none";
	deps.output("pr", String(pr));
	deps.output("head_sha", run.headSha);
	deps.output("run_url", run.runUrl);

	const { files, complete } = await listPrFiles(deps.api, deps.repo, pr);
	const names = files.map((f) => f.filename);
	let scope = scopeForFiles(names);
	// A capped file list cannot prove the PR leaves the UI alone: review everything.
	if (!complete) scope = allPagesScope(scope.files);
	deps.output("pages", scope.pages.join(","));
	deps.output("all_pages", String(scope.allPages));

	const skip = complete ? skipReason(names, scope) : null;
	const mode: Mode = skip !== null ? "skip" : run.conclusion === "success" ? "review" : "not-run";
	deps.log(`PR #${pr} at ${run.headSha}: ${mode} (${scope.pages.length} page(s) in scope)`);
	if (skip !== null) deps.output("skip_reason", skip);
	if (mode === "review") {
		mkdirSync(deps.outDir, { recursive: true });
		const staged = stageScreenshots(artifact, deps.outDir, scope.pages);
		writeFileSync(join(deps.outDir, "changed-files.txt"), `${names.join("\n")}\n`);
		writeFileSync(join(deps.outDir, "ui.diff"), buildDiff(files, scope.files));
		deps.log(`staged ${staged.length} screenshot(s) for ${scope.pages.join(", ")}`);
		await setCheck(deps.api, deps.repo, run.headSha, checkFor({ kind: "running" }, null), {
			detailsUrl: deps.reviewUrl,
		});
	}
	deps.output("mode", mode);
	return mode;
}

async function main(): Promise<void> {
	const repo = process.env.GH_REPO ?? "";
	const runId = process.env.RUN_ID ?? "";
	const outDir = process.env.OUT_DIR ?? "";
	const outputFile = process.env.GITHUB_OUTPUT ?? "";
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(runId) || outDir === "") {
		throw new Error("GH_REPO (owner/repo), RUN_ID (digits) and OUT_DIR are required");
	}
	const api: GhApi = ghCliApi();
	const mode = await runPrepare({
		api,
		repo,
		runId,
		outDir,
		download: (name) => ghDownload(repo, runId, name),
		now: new Date(),
		log: (line) => console.log(line),
		output: (key, value) => {
			console.log(`output ${key}=${value}`);
			if (outputFile !== "") appendFileSync(outputFile, `${key}=${value}\n`);
		},
		reviewUrl: process.env.REVIEW_URL ?? "",
		allowClosed: process.env.ALLOW_CLOSED === "true",
	});
	console.log(`design-review prepare: ${mode}`);
}

if (import.meta.main) await main();

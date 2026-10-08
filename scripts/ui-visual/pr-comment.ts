#!/usr/bin/env bun
/**
 * Post the ui-visual golden diffs as one sticky PR comment (warren-70d9).
 *
 * Entry point for `.github/workflows/ui-visual-comment.yml`, which runs on
 * every completed `UI visual` run from the default branch's code. Inputs are
 * env vars: `GH_REPO` (`owner/repo`), `RUN_ID` (the ui-visual run), and
 * `GH_TOKEN` for `gh`.
 *
 * Trust: the run's metadata comes from the API. The artifact is data the
 * PR's code wrote: `ci-meta.json` only proposes a PR number, which counts
 * only when that open PR's head is the run's head sha; `result.json` files
 * pass `parseGoldenResult`; PNGs go through the bounded decoder in `png.ts`.
 * Nothing from the artifact is executed.
 *
 * A `workflow_run` job reports no status on the PR, so an unexpected error
 * exits 1 (visible in the Actions tab) without blocking a merge. A crop
 * that cannot be published degrades to a comment that links the artifact.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARTIFACT_BRANCH, artifactPath, publishFiles } from "./artifact-branch.ts";
import {
	commentAction,
	cropNote,
	failureComment,
	type GoldenFailure,
	noDiffFailureComment,
	parseGoldenResult,
	pickFailures,
	type RunRef,
	resolvedComment,
	type ShownFailure,
	UI_VISUAL_MARKER,
} from "./diff-comment.ts";
import { composeFailure, type FailureImages } from "./diff-crop.ts";
import { type GhApi, ghCliApi } from "./gh-api.ts";
import { GOLDEN_DIFF_DIR } from "./golden-cases.ts";
import { decodePng, encodePng, pngSize } from "./png.ts";
import {
	findStickyComment,
	type StickyTarget,
	updateStickyCommentIfPresent,
	upsertStickyComment,
} from "./sticky-comment.ts";

/** The workflow whose runs this job reports on. */
export const UI_VISUAL_WORKFLOW_PATH = ".github/workflows/ui-visual.yml";
/** Skip any artifact file bigger than this (a full-page PNG is a few MB). */
const MAX_FILE_BYTES = 40 * 1024 * 1024;

export interface JobDeps {
	readonly api: GhApi;
	readonly repo: string;
	readonly runId: string;
	/** Download a named artifact of the run; resolves its directory or null. */
	readonly download: (name: string) => Promise<string | null>;
	readonly now: Date;
	readonly log: (line: string) => void;
}

interface RunInfo extends RunRef {
	readonly conclusion: string;
}

async function readRun(deps: JobDeps): Promise<RunInfo | null> {
	const run = (await deps.api.request("GET", `repos/${deps.repo}/actions/runs/${deps.runId}`)) as {
		path?: string;
		status?: string;
		conclusion?: string | null;
		head_sha?: string;
		html_url?: string;
	};
	if (run.path !== UI_VISUAL_WORKFLOW_PATH) {
		deps.log(`run ${deps.runId} is ${run.path ?? "unknown"}, not ${UI_VISUAL_WORKFLOW_PATH}`);
		return null;
	}
	const conclusion = run.conclusion ?? "";
	if (run.status !== "completed" || !["success", "failure"].includes(conclusion)) {
		deps.log(`run ${deps.runId} is ${run.status}/${conclusion}; nothing to report`);
		return null;
	}
	if (!/^[0-9a-f]{40}$/.test(run.head_sha ?? "") || run.html_url === undefined) return null;
	return { conclusion, headSha: run.head_sha ?? "", runUrl: run.html_url };
}

function readJson(path: string): unknown {
	if (!existsSync(path) || statSync(path).size > 1024 * 1024) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** The PR the artifact names, only if that open PR's head is the run's head. */
async function verifiedPr(deps: JobDeps, dir: string, headSha: string): Promise<number | null> {
	const meta = readJson(join(dir, "ci-meta.json")) as { pr?: unknown } | null;
	const pr = meta?.pr;
	if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) {
		deps.log("ci-meta.json names no PR (a push or dispatch run); nothing to report");
		return null;
	}
	const pull = (await deps.api.request("GET", `repos/${deps.repo}/pulls/${pr}`)) as {
		state?: string;
		head?: { sha?: string };
	};
	if (pull.state !== "open" || pull.head?.sha !== headSha) {
		deps.log(`PR #${pr} is ${pull.state} at ${pull.head?.sha ?? "?"}, not this run's ${headSha}`);
		return null;
	}
	return pr;
}

/** Every valid `golden-diff/<case>/result.json` in the artifact, by name. */
export function readFailures(dir: string): GoldenFailure[] {
	const root = join(dir, GOLDEN_DIFF_DIR);
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.sort()
		.flatMap((name) => {
			const failure = parseGoldenResult(readJson(join(root, name, "result.json")));
			return failure !== null && failure.name === name ? [failure] : [];
		});
}

function readImage(dir: string, failure: GoldenFailure, kind: string): Uint8Array | undefined {
	if (!failure.images.some((k) => k === kind)) return undefined;
	const path = join(dir, GOLDEN_DIFF_DIR, failure.name, `${kind}.png`);
	if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return undefined;
	return new Uint8Array(readFileSync(path));
}

/** Changed share of the golden's pixels, from Playwright's own count. */
function ratioOf(dir: string, failure: GoldenFailure): number | null {
	const expected = readImage(dir, failure, "expected");
	if (failure.reportedPixels === null || expected === undefined) return null;
	try {
		const { width, height } = pngSize(expected);
		return failure.reportedPixels / (width * height);
	} catch {
		return null;
	}
}

function decodeAll(dir: string, failure: GoldenFailure): FailureImages {
	const out: Record<string, ReturnType<typeof decodePng>> = {};
	for (const kind of ["expected", "actual", "diff"]) {
		const bytes = readImage(dir, failure, kind);
		if (bytes === undefined) continue;
		try {
			out[kind] = decodePng(bytes);
		} catch {
			// An unreadable image is left out of the composite.
		}
	}
	return out;
}

async function renderFailures(
	deps: JobDeps,
	dir: string,
	failures: readonly GoldenFailure[],
	pr: number,
	run: RunInfo,
): Promise<{ rows: ShownFailure[]; hidden: number }> {
	const { shown, hidden } = pickFailures(
		failures.map((failure) => ({ failure, ratio: ratioOf(dir, failure) })),
	);
	const files: { path: string; bytes: Uint8Array }[] = [];
	const rows = shown.map(({ failure, ratio }) => {
		const composite = composeFailure(decodeAll(dir, failure));
		if (composite === null) return { failure, ratio, imageUrl: null, note: "No image to crop." };
		files.push({
			path: artifactPath(deps.now, pr, run.headSha, failure.name),
			bytes: encodePng(composite.image),
		});
		return { failure, ratio, imageUrl: files.length - 1, note: cropNote(composite) };
	});
	let urls: string[] = [];
	try {
		urls = files.length === 0 ? [] : await publishFiles(deps.api, deps.repo, files, deps.now);
	} catch (error) {
		deps.log(`::warning::could not publish crops to ${ARTIFACT_BRANCH}: ${String(error)}`);
	}
	return {
		rows: rows.map((r) => ({
			...r,
			imageUrl: typeof r.imageUrl === "number" ? (urls[r.imageUrl] ?? null) : null,
		})),
		hidden,
	};
}

/** The whole job; returns what it did to the comment. */
export async function runCommentJob(deps: JobDeps): Promise<string> {
	const run = await readRun(deps);
	if (run === null) return "skipped";
	const dir = await deps.download(`ui-screenshots-${run.headSha}`);
	if (dir === null) {
		deps.log(`run ${deps.runId} uploaded no ui-screenshots-${run.headSha} artifact`);
		return "skipped";
	}
	const pr = await verifiedPr(deps, dir, run.headSha);
	if (pr === null) return "skipped";
	const target: StickyTarget = { repo: deps.repo, pr, marker: UI_VISUAL_MARKER };
	const failures = readFailures(dir);
	const existing = await findStickyComment(deps.api, target);
	const action = commentAction({
		conclusion: run.conclusion,
		failures: failures.length,
		hasComment: existing !== null,
	});
	deps.log(`PR #${pr}: ${failures.length} golden failure(s), action ${action}`);
	if (action === "none") return action;
	if (action === "post-failures") {
		const { rows, hidden } = await renderFailures(deps, dir, failures, pr, run);
		const result = await upsertStickyComment(
			deps.api,
			target,
			failureComment(run, rows, hidden),
			existing,
		);
		return `${action}:${result.action}`;
	}
	const body = action === "resolve" ? resolvedComment(run) : noDiffFailureComment(run);
	const result = await updateStickyCommentIfPresent(deps.api, target, body, existing);
	return `${action}:${result.action}`;
}

function ghDownload(repo: string, runId: string, name: string): Promise<string | null> {
	const dir = mkdtempSync(join(tmpdir(), "ui-visual-comment-"));
	const result = spawnSync(
		"gh",
		["run", "download", runId, "--repo", repo, "--name", name, "--dir", dir],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		console.log(`gh run download failed: ${result.stderr.trim()}`);
		return Promise.resolve(null);
	}
	return Promise.resolve(dir);
}

async function main(): Promise<void> {
	const repo = process.env.GH_REPO ?? "";
	const runId = process.env.RUN_ID ?? "";
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(runId)) {
		throw new Error("GH_REPO (owner/repo) and RUN_ID (digits) are required");
	}
	try {
		const outcome = await runCommentJob({
			api: ghCliApi(),
			repo,
			runId,
			download: (name) => ghDownload(repo, runId, name),
			now: new Date(),
			log: (line) => console.log(line),
		});
		console.log(`ui-visual comment: ${outcome}`);
	} catch (error) {
		console.log(`::error::ui-visual comment failed: ${String(error)}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
